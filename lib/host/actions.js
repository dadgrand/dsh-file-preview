/**
 * OS-level actions for the file-preview modal: open, reveal, browser, copy-file.
 *
 * **Why processes and not Electron.** The Desktop Host runs the Electron
 * binary with `ELECTRON_RUN_AS_NODE=1`, in a child process: `require('electron')`
 * throws MODULE_NOT_FOUND and the ESM namespace has no `shell`/`clipboard`
 * (research `.research/file-preview/findings.md` §6). The shipped
 * `@deepseek-ai/dsh-host-open-in-app` solves the same problem the same way —
 * a shell-free `spawn` of the OS opener. This module follows its command
 * lines (`@deepseek-ai/dsh-native-command/lib/types/path-opener.js`):
 *
 * | action    | Windows                         | macOS          | Linux           |
 * |-----------|---------------------------------|----------------|-----------------|
 * | open      | `explorer.exe <file URI>`       | `open <path>`  | `xdg-open <path>` |
 * | reveal    | `explorer.exe /select,<file URI>` | `open -R <path>` | `xdg-open <dir>` |
 * | browser   | `rundll32.exe url.dll,FileProtocolHandler <url>` | `open <url>` | `xdg-open <url>` |
 * | copy-file | fixed PowerShell `SetFileDropList` | fixed `osascript` POSIX file | unavailable |
 *
 * Explorer receives one argv element and parses its own command line, so the
 * path is encoded exactly as the shipped opener does it (commas and equals
 * escaped; percent escapes standing for non-ASCII decoded back).
 *
 * `copy-file` puts the actual file on the OS clipboard (a file-drop list on
 * Windows, a POSIX file reference on macOS). Linux has no portable file-drop
 * clipboard, so it answers `action-unavailable`. The clipboard launcher is
 * argv-only and waited on (short settle window) because its exit status is the
 * only success signal.
 *
 * {@link spawnDetached} is the single documented fallback for a Host without
 * Electron: every open/reveal/browser launcher goes through it, detached, with
 * `stdio: 'ignore'`, no shell, and no inherited credentials beyond the process
 * environment. When no launcher exists for the action/platform the route
 * answers `{ok:false, code:'action-unavailable'}` instead of throwing.
 *
 * @module dsh-file-preview/host/actions
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Actions the host half performs. Clipboard text/image is the client's job. */
export const SUPPORTED_ACTIONS = Object.freeze(['open', 'reveal', 'browser', 'copy-file'])

/** Default settle budget for the clipboard launcher (HTTP answers within ~3 s). */
const COPY_FILE_TIMEOUT_MS = 3_000

/**
 * The fixed Windows clipboard script. The path never enters this text: it is
 * read from `$args[0]`, which receives one separate argv element. The outer
 * `& { ... }` script block is what lets `-Command` pass the trailing argv into
 * `$args`.
 */
export const COPY_FILE_PS_SCRIPT = '& { ' + [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$files = New-Object System.Collections.Specialized.StringCollection',
  '[void]$files.Add([string]$args[0])',
  '[System.Windows.Forms.Clipboard]::SetFileDropList($files)',
].join('; ') + ' }'

/** The fixed macOS clipboard statement; the path arrives as `argv` item 1. */
export const COPY_FILE_OSASCRIPT_SCRIPT = 'set the clipboard to (POSIX file (item 1 of argv)) as alias'

/**
 * Encode one Windows path as the target Explorer can receive intact.
 * Copied from `@deepseek-ai/dsh-native-command` path-opener semantics:
 * Explorer splits its command line at commas and equals signs, so those are
 * escaped, while percent escapes that spell non-ASCII characters are decoded
 * back (Explorer resolves the literal characters).
 * @param {string} windowsPath - Windows path.
 * @returns {string} file URI suitable as one Explorer argv element.
 */
export function explorerTarget(windowsPath) {
  const href = pathToFileURL(windowsPath, { windows: true }).href
  return href
    .replace(/(?:%[89A-F][0-9A-F])+/gi, escaped => decodeURIComponent(escaped))
    .replaceAll(',', '%2C')
    .replaceAll('=', '%3D')
}

/**
 * Resolve Windows PowerShell from the system root, with a PATH fallback.
 * `SystemRoot` is the Windows installation directory, so the absolute system
 * copy is preferred over whatever `powershell.exe` PATH happens to find.
 * @param {Record<string, string|undefined>} [env] - environment (test seam).
 * @param {(path: string) => boolean} [exists] - existence check (test seam).
 * @returns {string} absolute PowerShell path, or `powershell.exe` as fallback.
 */
export function resolveWindowsPowerShell(env = process.env, exists = existsSync) {
  const root = env.SystemRoot ?? env.windir
  if (typeof root === 'string' && root !== '') {
    const candidate = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (exists(candidate)) return candidate
  }
  return 'powershell.exe'
}

/**
 * One path token for Windows PowerShell's `-Command` tail.
 *
 * Windows PowerShell 5.1 joins the arguments after `-Command` and re-parses
 * them, so an unquoted path with spaces would arrive split. Safe paths are
 * passed literally; anything else is single-quoted for that parser (`'` is
 * doubled) — the path still travels as its own argv element and is never
 * interpolated into the script text.
 * @param {string} path - absolute file path.
 * @returns {string} PowerShell-safe argument token.
 */
export function powerShellPathArgument(path) {
  return /^[\w:.\u002f\u005c-]+$/.test(path) ? path : `'${path.replaceAll("'", "''")}'`
}

/**
 * The clipboard launcher for one platform, or null when it has no portable
 * file-drop clipboard.
 * @param {object} request - launcher facts.
 * @param {string} request.platform - `process.platform`.
 * @param {string} request.path - absolute existing file.
 * @param {Record<string, string|undefined>} [request.env] - environment.
 * @returns {{command: string, args: string[]}|null} launcher argv.
 */
export function copyFileLauncher({ platform, path, env = process.env }) {
  if (platform === 'win32') {
    return {
      command: resolveWindowsPowerShell(env),
      args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', COPY_FILE_PS_SCRIPT, powerShellPathArgument(path)],
    }
  }
  if (platform === 'darwin') {
    return {
      command: 'osascript',
      args: ['-e', 'on run argv', '-e', COPY_FILE_OSASCRIPT_SCRIPT, '-e', 'end run', path],
    }
  }
  return null
}

/**
 * The launcher for one action, or null when this platform has none.
 * `copy-file` has its own waited launcher ({@link copyFileLauncher}).
 * @param {object} request - action facts.
 * @param {'open'|'reveal'|'browser'} request.action - action name.
 * @param {string} request.platform - `process.platform`.
 * @param {string} [request.path] - absolute path for open/reveal/browser-file.
 * @param {string} [request.url] - URL for browser.
 * @returns {{command: string, args: string[]}|null} launcher argv.
 */
export function launcherFor({ action, platform, path, url }) {
  if (action === 'browser') {
    const target = typeof url === 'string' && url !== '' ? url : (typeof path === 'string' ? pathToFileURL(path).href : '')
    if (target === '') return null
    if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', target] }
    if (platform === 'darwin') return { command: 'open', args: [target] }
    if (platform === 'linux') return { command: 'xdg-open', args: [target] }
    return null
  }
  if (typeof path !== 'string' || path === '') return null
  if (action === 'open') {
    if (platform === 'win32') return { command: 'explorer.exe', args: [explorerTarget(path)] }
    if (platform === 'darwin') return { command: 'open', args: [path] }
    if (platform === 'linux') return { command: 'xdg-open', args: [path] }
    return null
  }
  if (action === 'reveal') {
    if (platform === 'win32') return { command: 'explorer.exe', args: ['/select,', explorerTarget(path)] }
    if (platform === 'darwin') return { command: 'open', args: ['-R', path] }
    if (platform === 'linux') return { command: 'xdg-open', args: [dirname(path)] }
    return null
  }
  return null
}

/**
 * Spawn one launcher detached from the Host: no shell, no stdio pipe, and the
 * child outlives the request. Resolves once the process spawned (not when its
 * window closes); rejects on a spawn failure such as ENOENT.
 * @param {string} command - executable name or absolute path.
 * @param {string[]} args - argv, never a shell string.
 * @param {object} [options] - spawn options merged over the safe defaults.
 * @returns {Promise<void>} resolves after a successful spawn.
 */
export function spawnDetached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        ...options,
      })
    } catch (error) {
      reject(error)
      return
    }
    let settled = false
    child.once('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolve()
    })
  })
}

/**
 * Run one clipboard launcher to completion with a short settle window.
 *
 * The clipboard write has no other success signal than the process exit code,
 * so this waiter is deliberately not detached: exit 0 means the OS clipboard
 * accepted the file drop, any other outcome is a typed failure. A launcher
 * that outlives the window is killed and reported as a timeout, which keeps the
 * HTTP answer under the caller's ~3 s budget.
 * @param {string} command - executable path or name.
 * @param {string[]} args - argv, never a shell string.
 * @param {object} [options] - waiter options.
 * @param {number} [options.timeoutMs] - settle budget.
 * @returns {Promise<{ok: true}|{ok: false, code: 'copy-file-failed', message: string}>} outcome.
 */
export function waitForLauncher(command, args, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : COPY_FILE_TIMEOUT_MS
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    } catch (error) {
      resolve({ ok: false, code: 'copy-file-failed', message: error instanceof Error ? error.message : String(error) })
      return
    }
    let settled = false
    let timer
    const settle = outcome => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(outcome)
    }
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone: the timeout outcome still applies.
      }
      settle({ ok: false, code: 'copy-file-failed', message: `launcher timed out after ${String(timeoutMs)} ms` })
    }, timeoutMs)
    child.once('error', error => {
      settle({ ok: false, code: 'copy-file-failed', message: error instanceof Error ? error.message : String(error) })
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        settle({ ok: true })
        return
      }
      const suffix = typeof signal === 'string' && signal !== '' ? `, signal ${signal}` : ''
      settle({ ok: false, code: 'copy-file-failed', message: `launcher exited with code ${String(code)}${suffix}` })
    })
  })
}

/**
 * Put one validated file on the OS clipboard.
 * @param {object} request - action facts.
 * @param {string} request.path - absolute path.
 * @param {string} request.platform - `process.platform`.
 * @param {Record<string, string|undefined>} [request.env] - environment.
 * @param {Function} [request.wait] - waiter seam; default {@link waitForLauncher}.
 * @param {number} [request.copyTimeoutMs] - settle budget.
 * @returns {Promise<{ok: true}|{ok: false, code: string, message: string}>} outcome.
 */
async function copyFileAction(request) {
  const { path } = request
  if (typeof path !== 'string' || !isAbsolute(path)) {
    return { ok: false, code: 'bad-path', message: 'copy-file requires an absolute path' }
  }
  let info
  try {
    info = await fsp.stat(path)
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, code: 'not-found', message: 'copy-file path does not exist' }
    }
    return { ok: false, code: 'copy-file-failed', message: error instanceof Error ? error.message : String(error) }
  }
  if (!info.isFile()) {
    return { ok: false, code: 'not-a-file', message: 'copy-file requires a regular file' }
  }
  const launcher = copyFileLauncher({ platform: request.platform, path, env: request.env })
  if (launcher === null) {
    return {
      ok: false,
      code: 'action-unavailable',
      message: `file clipboard is not available on ${String(request.platform)}`,
    }
  }
  const wait = typeof request.wait === 'function' ? request.wait : waitForLauncher
  const timeoutMs = Number.isFinite(request.copyTimeoutMs) ? request.copyTimeoutMs : COPY_FILE_TIMEOUT_MS
  try {
    const outcome = await wait(launcher.command, launcher.args, { timeoutMs, windowsHide: true })
    if (outcome === undefined || outcome === null || outcome.ok === true) return { ok: true }
    return {
      ok: false,
      code: 'copy-file-failed',
      message: typeof outcome.message === 'string' && outcome.message !== ''
        ? outcome.message
        : 'file clipboard launcher failed',
    }
  } catch (error) {
    return { ok: false, code: 'copy-file-failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Perform one OS action.
 * @param {object} request - action facts.
 * @param {'open'|'reveal'|'browser'|'copy-file'} request.action - action name.
 * @param {string} [request.path] - absolute existing path.
 * @param {string} [request.url] - http(s) or file URL for `browser`.
 * @param {string} [request.platform] - `process.platform` override (tests).
 * @param {Function} [request.launch] - detached spawn seam (tests).
 * @param {Function} [request.wait] - clipboard waiter seam (tests).
 * @param {number} [request.copyTimeoutMs] - clipboard settle budget.
 * @returns {Promise<{ok: true}|{ok: false, code: string, message: string}>} outcome.
 */
export async function performAction(request) {
  const { action, path, url } = request
  const platform = request.platform ?? process.platform
  if (!SUPPORTED_ACTIONS.includes(action)) {
    return { ok: false, code: 'bad-request', message: `unsupported action: ${String(action)}` }
  }
  if (action === 'copy-file') {
    return copyFileAction({ ...request, platform })
  }
  const launch = request.launch ?? spawnDetached
  const launcher = launcherFor({ action, platform, path, url })
  if (launcher === null) {
    return {
      ok: false,
      code: 'action-unavailable',
      message: `no ${action} launcher for platform ${platform}`,
    }
  }
  try {
    await launch(launcher.command, launcher.args, { detached: true, stdio: 'ignore', windowsHide: true })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: 'action-failed', message }
  }
}
