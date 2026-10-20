#!/usr/bin/env node
/**
 * Bundle/manifest check for dsh-file-preview.
 *
 * Verifies the parts the Loader and Plugin Manager read before activation:
 *
 * - minimal manifest identity (`name`, `version`, `type`, `main`);
 * - the required `exports` entries, `dsh.engines.dsh`, `dsh.bundle.patch` and
 *   the `dsh.client` web row;
 * - the bundle patch inserts exactly one row, `id: file-preview`,
 *   `name: dsh-file-preview`;
 * - every `.js` file in the package passes `node --check`;
 * - `icon.svg` exists, is valid-looking and below the 256 KiB limit;
 * - declared locale JSON files parse when present (a missing locale directory
 *   is accepted: the client half owns it);
 * - `./client` is declared while `lib/client.js` is authored in parallel — the
 *   check accepts either absent (host task) or present (client task) and
 *   validates the loader marker when present;
 * - no npm dependencies were added.
 *
 * Usage: node scripts/check-bundle.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const state = { passed: 0, failed: 0 }

async function check(name, fn) {
  try {
    await fn()
    state.passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    state.failed += 1
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function readJson(path) {
  return JSON.parse(await fsp.readFile(path, 'utf8'))
}

/** Every `.js` file below the package, excluding node_modules. */
async function listJavaScript(directory) {
  const found = []
  const stack = [directory]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) stack.push(absolute)
      else if (entry.isFile() && entry.name.endsWith('.js')) found.push(absolute)
    }
  }
  return found.sort()
}

const manifestPath = join(root, 'package.json')
const manifest = await readJson(manifestPath)

await check('manifest identity: name dsh-file-preview, version 0.1.0, type module, main index.js', () => {
  assert(manifest.name === 'dsh-file-preview', `name = ${String(manifest.name)}`)
  assert(manifest.version === '0.1.0', `version = ${String(manifest.version)}`)
  assert(manifest.type === 'module', `type = ${String(manifest.type)}`)
  assert(manifest.main === 'index.js', `main = ${String(manifest.main)}`)
})

await check('exports declare ., ./client, ./package.json, ./cordis.patch.yml and locale JSON', () => {
  const exportsField = manifest.exports ?? {}
  assert(exportsField['.'] === './index.js', 'exports["."] must be ./index.js')
  assert(exportsField['./client'] === './lib/client.js', 'exports["./client"] must be ./lib/client.js')
  assert(exportsField['./package.json'] === './package.json', 'exports["./package.json"] missing')
  assert(exportsField['./cordis.patch.yml'] === './cordis.patch.yml', 'exports["./cordis.patch.yml"] missing')
  assert(exportsField['./locale/*.json'] === './locale/*.json', 'exports["./locale/*.json"] missing')
})

await check('dsh.engines.dsh, dsh.bundle.patch and the web client row are exact', () => {
  const dsh = manifest.dsh ?? {}
  assert(String(dsh.engines?.dsh ?? '').includes('0.2.0-rc.2'), 'dsh.engines.dsh must require >= 0.2.0-rc.2')
  assert(String(dsh.engines?.dsh ?? '').startsWith('>='), 'dsh.engines.dsh must be a lower bound')
  assert(dsh.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch must be ./cordis.patch.yml')
  const client = dsh.client ?? {}
  assert(client.platform === 'web', 'dsh.client.platform must be web')
  assert(client.immediately === true, 'dsh.client.immediately must be true')
  assert(Array.isArray(client.inject) && client.inject.length === 0, 'dsh.client.inject must be []')
})

await check('no npm dependencies were added', () => {
  assert(manifest.dependencies === undefined || Object.keys(manifest.dependencies).length === 0, 'dependencies must stay empty')
  assert(manifest.peerDependencies === undefined || Object.keys(manifest.peerDependencies).length === 0, 'peerDependencies must stay empty')
})

const patchPath = join(root, 'cordis.patch.yml')
await check('bundle patch inserts exactly one row: file-preview -> dsh-file-preview', async () => {
  const text = await fsp.readFile(patchPath, 'utf8')
  const inserts = text.match(/^\s*-\s*insert:\s*$/gm) ?? []
  assert(inserts.length === 1, `expected one "- insert:", found ${String(inserts.length)}`)
  const ids = [...text.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map(match => match[1])
  assert(ids.length === 1, `expected one row id, found ${ids.join(', ')}`)
  assert(ids[0] === 'file-preview', `row id = ${ids[0]}`)
  assert(/name:\s*['"]?dsh-file-preview['"]?\s*$/m.test(text), 'row name must be dsh-file-preview')
})

await check('the client export is declared and lib/client.js is accepted absent or valid when present', async () => {
  const clientPath = join(root, 'lib/client.js')
  if (!existsSync(clientPath)) {
    console.log('     note: lib/client.js is absent (host task); the client task authors it in parallel')
    return
  }
  const text = await fsp.readFile(clientPath, 'utf8')
  assert(text.includes('__ModuleLoader__'), 'lib/client.js must register through window.__ModuleLoader__.load')
})

await check('locale files are declared and parse when present', async () => {
  const localeDir = join(root, 'locale')
  if (!existsSync(localeDir)) {
    console.log('     note: locale/ is absent (client task owns it); manifest still declares the selector')
    return
  }
  const files = (await fsp.readdir(localeDir)).filter(name => name.endsWith('.json'))
  assert(files.length > 0, 'locale/ exists but contains no JSON files')
  for (const file of files) {
    const document = await readJson(join(localeDir, file))
    assert(typeof document === 'object' && document !== null, `${file} must parse to an object`)
  }
})

await check('icon.svg exists, is SVG and stays under 256 KiB', async () => {
  const iconPath = join(root, 'icon.svg')
  const info = await fsp.stat(iconPath)
  assert(info.isFile(), 'icon.svg is not a file')
  assert(info.size <= 256 * 1024, `icon.svg is ${String(info.size)} bytes`)
  assert(info.size > 200, 'icon.svg is suspiciously small')
  const text = await fsp.readFile(iconPath, 'utf8')
  assert(/<svg[\s>]/.test(text), 'icon.svg does not open an <svg> element')
  assert(text.includes('</svg>'), 'icon.svg is not closed')
  assert(text.includes('viewBox'), 'icon.svg needs a viewBox')
})

await check('README.md exists, is non-empty and is written in Russian', async () => {
  const readme = await fsp.readFile(join(root, 'README.md'), 'utf8')
  assert(readme.length > 500, 'README.md is too short to document the plugin')
  assert(/[А-Яа-яЁё]/.test(readme), 'README.md must be in Russian')
  for (const needle of ['/meta', '/raw', '/text', '/office-pdf', '/link', '/resolve', '/action', '/status', 'allowRoots', 'seat']) {
    assert(readme.includes(needle), `README.md does not document ${needle}`)
  }
})

await check('every .js file in the package passes node --check', async () => {
  const files = await listJavaScript(root)
  assert(files.length >= 10, `expected the host modules, found ${String(files.length)} .js files`)
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert(result.status === 0, `${relative(root, file)}: ${result.stderr.trim()}`)
  }
})

await check('index.js exports name, inject and apply', async () => {
  const text = await fsp.readFile(join(root, 'index.js'), 'utf8')
  assert(/export\s+const\s+name\s*=\s*['"]dsh-file-preview['"]/.test(text), 'index.js must export name')
  assert(/export\s+const\s+inject\s*=\s*\[[^\]]*['"]webServer['"]/.test(text), 'index.js must export inject = [webServer]')
  assert(/export\s+function\s+apply\s*\(/.test(text), 'index.js must export apply(ctx)')
})

console.log(`\nSUMMARY ${state.passed} passed, ${state.failed} failed`)
if (state.failed > 0) process.exitCode = 1
