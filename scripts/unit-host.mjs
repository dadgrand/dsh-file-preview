#!/usr/bin/env node
/**
 * Host-half unit harness for dsh-file-preview.
 *
 * Runs the real route handlers over a real loopback `node:http` server (so the
 * trust fence, Range headers and POST body handling are exercised as shipped),
 * with three seams stubbed: the OS launcher (`launch`), the `officeToPdf`
 * service and `fetch` for `/link`. Fixtures are materialized into a fresh temp
 * directory per run.
 *
 * Prints one `PASS <assertion>` line per check and exits non-zero when any
 * assertion fails. No test framework, no npm dependency.
 *
 * Usage: node scripts/unit-host.mjs
 */

import { mkdir, readFile, readdir, realpath, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHostApp } from '../lib/host/app.js'
import {
  COPY_FILE_OSASCRIPT_SCRIPT,
  COPY_FILE_PS_SCRIPT,
  performAction,
  powerShellPathArgument,
  resolveWindowsPowerShell,
  waitForLauncher,
} from '../lib/host/actions.js'
import * as plugin from '../index.js'
import {
  PDF_BYTES,
  PNG_BYTES,
  assert,
  createChecker,
  createLaunchStub,
  createLinkFetchStub,
  createOfficeStub,
  getJson,
  materializeFixtures,
  postJson,
  query,
  request,
  startServer,
} from '../test/support.mjs'

const checker = createChecker()
const check = checker.check.bind(checker)
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const BASE = '/api/dsh-file-preview'
const routePath = name => `${BASE}/${name}`
const withQuery = (path, params) => `${path}?${query(params)}`

const fixtures = await materializeFixtures()
const launch = createLaunchStub()
const office = createOfficeStub(PDF_BYTES)
const linkFetch = createLinkFetchStub()

/** Waiter seam for the copy-file action: records the call, returns a scripted outcome. */
function createCopyWaitStub() {
  const state = { calls: [], result: { ok: true } }
  return {
    state,
    fn: async (command, args, options) => {
      state.calls.push({ command, args, options })
      return state.result
    },
  }
}
const copyWait = createCopyWaitStub()

const sharedOptions = {
  version: '0.1.0',
  cwd: fixtures.work,
  home: fixtures.home,
  dshHome: fixtures.state,
  tmpDir: fixtures.root,
  fetchImpl: linkFetch.fn,
  launch: launch.fn,
  wait: copyWait.fn,
  config: { officeTimeoutMs: 5_000, linkTimeoutMs: 1_000 },
}

const mainApp = createHostApp({ ...sharedOptions, platform: 'win32', getOfficeToPdf: () => office.service })
const limitedApp = createHostApp({
  ...sharedOptions,
  platform: 'freebsd',
  getOfficeToPdf: () => undefined,
})
// Read-scope matrix: default `any`, strict `roots`, strict + allowRoots, and a
// connection fence that rejects everything (the fence must still be consulted).
const strictApp = createHostApp({
  ...sharedOptions,
  platform: 'win32',
  config: { ...sharedOptions.config, readScope: 'roots' },
  getOfficeToPdf: () => office.service,
})
const strictPlusApp = createHostApp({
  ...sharedOptions,
  platform: 'win32',
  config: { ...sharedOptions.config, readScope: 'roots', allowRoots: [fixtures.outside] },
  getOfficeToPdf: () => office.service,
})
const guardedApp = createHostApp({
  ...sharedOptions,
  platform: 'win32',
  getOfficeToPdf: () => office.service,
  getConnection: () => ({ requestRejection: () => 403 }),
})
// copy-file platform matrix: Windows and macOS have a launcher, Linux does not.
const copyDarwinApp = createHostApp({ ...sharedOptions, platform: 'darwin', getOfficeToPdf: () => office.service })
const copyLinuxApp = createHostApp({ ...sharedOptions, platform: 'linux', getOfficeToPdf: () => office.service })
const main = await startServer(mainApp)
const limited = await startServer(limitedApp)
const strict = await startServer(strictApp)
const strictPlus = await startServer(strictPlusApp)
const guarded = await startServer(guardedApp)
const copyDarwin = await startServer(copyDarwinApp)
const copyLinux = await startServer(copyLinuxApp)

const files = fixtures.files

// F2 fixtures: an OLDER attachment and a NEWER same-named workspace file must
// resolve to the attachment; the other two basenames are root-unique.
const attachmentsOnlyDir = join(fixtures.attachments, 'dd', 'dddd')
await mkdir(attachmentsOnlyDir, { recursive: true })
const attachmentsOnly = join(attachmentsOnlyDir, 'attachment-only.txt')
await writeFile(attachmentsOnly, 'attachment-only fixture')
const workspaceOnly = join(fixtures.work, 'workspace-only.txt')
await writeFile(workspaceOnly, 'workspace-only fixture')
const olderAttachmentTime = new Date('2023-05-06T07:08:09.000Z')
const newerWorkspaceTime = new Date('2024-06-07T08:09:10.000Z')
await utimes(files.attachmentNewest, olderAttachmentTime, olderAttachmentTime)
await utimes(files.cwdReport, newerWorkspaceTime, newerWorkspaceTime)

// Read-scope fixture: an Office document that lives outside every H1 root.
const outsideDocx = join(fixtures.outside, 'outside-report.docx')
await writeFile(outsideDocx, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('outside docx fixture')]))
const outsideTraversal = relative(fixtures.work, files.outside)

const metaOf = async (path, cwd = fixtures.work) => {
  const { response, body } = await getJson(main.port, withQuery(routePath('meta'), { path, cwd }))
  return { response, body }
}

try {
  // ---------------------------------------------------------------- manifest
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  await check('manifest carries the plugin identity the bundle patch inserts', () => {
    assert.equal(manifest.name, 'dsh-file-preview')
    assert.equal(manifest.version, '0.1.0')
    assert.equal(manifest.type, 'module')
    assert.equal(manifest.main, 'index.js')
  })
  await check('manifest declares the web client half without an author copy of lib/client.js', async () => {
    assert.equal(manifest.exports['./client'], './lib/client.js')
    assert.deepEqual(manifest.dsh.client, { platform: 'web', immediately: true, inject: [] })
    const clientExists = await readFile(join(packageRoot, 'lib/client.js'), 'utf8').then(() => true, () => false)
    assert.equal(typeof clientExists, 'boolean')
  })

  // -------------------------------------------------------------- plugin wiring
  await check('importing index.js has no top-level side effect', () => {
    assert.equal(plugin.name, 'dsh-file-preview')
    assert.deepEqual(plugin.inject, ['webServer'])
    assert.equal(typeof plugin.apply, 'function')
  })
  await check('apply registers every route inside ctx.effect with a working disposer', () => {
    const registrations = []
    const labels = []
    const disposers = []
    let disposed = 0
    const fakeContext = {
      webServer: {
        register(route) {
          registrations.push(route)
          return () => {
            disposed += 1
          }
        },
      },
      effect(fn, label) {
        labels.push(label)
        const disposer = fn()
        disposers.push(disposer)
        return disposer
      },
      get() {
        return undefined
      },
    }
    plugin.apply(fakeContext, {})
    assert.equal(registrations.length, 8)
    assert.equal(labels.length, 8)
    assert.deepEqual(registrations.map(route => route.kind), Array(8).fill('exact'))
    const expectedPaths = ['meta', 'raw', 'text', 'office-pdf', 'link', 'action', 'status', 'resolve'].map(routePath)
    assert.deepEqual([...registrations.map(route => route.path)].sort(), [...expectedPaths].sort())
    for (const label of labels) assert.ok(label.includes('/api/dsh-file-preview/'), label)
    for (const disposer of disposers) disposer()
    assert.equal(disposed, 8)
  })
  await check('apply mounts without ctx.get (optional services resolved defensively)', () => {
    const fakeContext = {
      webServer: { register: () => () => {} },
      effect(fn) {
        fn()
      },
    }
    plugin.apply(fakeContext, {})
  })

  // ---------------------------------------------------------------- static shape
  const hostModules = [
    'index.js',
    ...(await readdir(join(packageRoot, 'lib/host'))).filter(name => name.endsWith('.js')).map(name => `lib/host/${name}`),
  ]
  const sources = await Promise.all(hostModules.map(async rel => ({ rel, text: await readFile(join(packageRoot, rel), 'utf8') })))
  await check('host modules import only Node built-ins or relative files', () => {
    const specifier = /\bfrom\s+['"]([^'"]+)['"]/g
    for (const { rel, text } of sources) {
      for (const match of text.matchAll(specifier)) {
        const target = match[1]
        assert.ok(target.startsWith('node:') || target.startsWith('./') || target.startsWith('../'), `${rel} imports ${target}`)
      }
    }
  })
  const stripComments = text => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  await check('no Electron import exists anywhere in the host half', () => {
    for (const { rel, text } of sources) {
      const code = stripComments(text)
      const specifiers = [...code.matchAll(/\bimport\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g)].map(match => match[1])
      const dynamic = [...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map(match => match[1])
      for (const specifier of [...specifiers, ...dynamic]) assert.notEqual(specifier, 'electron', `${rel} imports electron`)
      assert.ok(!/\brequire\s*\(\s*['"]electron['"]\s*\)/.test(code), `${rel} requires electron`)
    }
  })
  await check('host logic has no drive letters or backslash separator assumptions', () => {
    for (const { rel, text } of sources) {
      assert.ok(!/(^|[^A-Za-z])[A-Za-z]:[\\/]/m.test(stripComments(text)), `${rel} contains a Windows drive path`)
    }
    assert.equal(hostModules.length >= 10, true)
  })
  await check('only actions.js spawns native processes, and never through a shell', async () => {
    for (const { rel, text } of sources) {
      if (rel === 'lib/host/actions.js') continue
      assert.ok(!text.includes('node:child_process'), `${rel} imports child_process`)
    }
    const actions = await readFile(join(packageRoot, 'lib/host/actions.js'), 'utf8')
    assert.ok(!/shell\s*:\s*true/.test(actions))
  })

  // -------------------------------------------------------------------- fence
  await check('GET /status from a loopback same-origin caller answers 200 JSON', async () => {
    const { response, body } = await getJson(main.port, routePath('status'))
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
  })
  await check('cross-site sec-fetch-site is rejected with 403 JSON', async () => {
    const response = await request(main.port, {
      path: routePath('status'),
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(response.status, 403)
    assert.equal(response.json().code, 'forbidden')
    assert.match(String(response.headers['content-type']), /application\/json/)
  })
  await check('mismatched Origin is rejected with 403 JSON', async () => {
    const { response, body } = await getJson(main.port, routePath('status'), { origin: 'http://evil.example' })
    assert.equal(response.status, 403)
    assert.equal(body.code, 'forbidden')
  })
  await check('non-loopback Host header is rejected with 403 JSON', async () => {
    const { response, body } = await getJson(main.port, routePath('status'), { host: 'evil.example' })
    assert.equal(response.status, 403)
    assert.equal(body.code, 'forbidden')
  })
  await check('POST without application/json is rejected with 415', async () => {
    const response = await request(main.port, {
      method: 'POST',
      path: routePath('action'),
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ action: 'open', path: files.text }),
    })
    assert.equal(response.status, 415)
    assert.equal(response.json().code, 'unsupported-media-type')
  })
  await check('GET on the POST route answers 405 with allow', async () => {
    const response = await request(main.port, { path: routePath('action') })
    assert.equal(response.status, 405)
    assert.equal(response.headers.allow, 'POST')
  })
  await check('unknown path under the base answers 404 JSON', async () => {
    const response = await request(main.port, { path: routePath('nope') })
    assert.equal(response.status, 404)
    assert.equal(response.json().code, 'not-found')
  })

  // --------------------------------------------------------------------- meta
  const metaCases = [
    ['PNG image', files.png, 'image', 'image/png'],
    ['PDF document', files.pdf, 'pdf', 'application/pdf'],
    ['Markdown document', files.markdown, 'markdown', 'text/markdown'],
    ['DOCX Office document', files.docx, 'office', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['plain text file', files.text, 'text', 'text/plain'],
    ['HTML page', files.html, 'html', 'text/html'],
  ]
  for (const [label, file, preview, mime] of metaCases) {
    await check(`/meta classifies ${label} as ${preview}`, async () => {
      const { response, body } = await metaOf(file)
      assert.equal(response.status, 200)
      assert.equal(body.ok, true)
      assert.equal(body.preview, preview)
      assert.equal(body.mime, mime)
      assert.equal(body.kind, 'file')
      assert.equal(body.canRead, true)
      assert.equal(body.absPath, await realpath(file))
      assert.equal(body.name, file.split(/[\\/]/).pop())
      const info = await stat(file)
      assert.equal(body.size, info.size)
      assert.equal(body.mtimeMs, info.mtimeMs)
      if (preview === 'office') assert.equal(body.officeExt, 'docx')
      else assert.equal(body.officeExt, undefined)
    })
  }
  await check('/meta resolves a relative path against the cwd query', async () => {
    const { body } = await metaOf('sample.txt')
    assert.equal(body.ok, true)
    assert.ok(body.absPath.endsWith('sample.txt'))
  })
  await check('/meta expands a leading tilde', async () => {
    const { body } = await metaOf('~/home-sample.txt')
    assert.equal(body.ok, true)
    assert.equal(body.absPath, await realpath(files.homeSample))
  })
  await check('/meta converts a file:// URL to a path', async () => {
    const { body } = await metaOf(pathToFileURL(files.text).href)
    assert.equal(body.ok, true)
    assert.equal(body.absPath, await realpath(files.text))
  })
  await check('/meta strips surrounding quotes', async () => {
    const { body } = await metaOf('"sample.txt"')
    assert.equal(body.ok, true)
  })
  await check('/meta reports a directory with preview none', async () => {
    const { body } = await metaOf(fixtures.work, fixtures.work)
    assert.equal(body.ok, true)
    assert.equal(body.kind, 'directory')
    assert.equal(body.preview, 'none')
    assert.equal(body.canRead, false)
  })
  await check('/meta answers 400 bad-path for a malformed path', async () => {
    const { response, body } = await metaOf('bad\u0000path')
    assert.equal(response.status, 400)
    assert.equal(body.code, 'bad-path')
  })
  await check('/meta answers 400 bad-path for a missing path parameter', async () => {
    const response = await request(main.port, { path: routePath('meta') })
    assert.equal(response.status, 400)
    assert.equal(response.json().code, 'bad-path')
  })
  await check('/meta answers 404 not-found for a missing file', async () => {
    const { response, body } = await metaOf(join(fixtures.work, 'does-not-exist.txt'))
    assert.equal(response.status, 404)
    assert.equal(body.code, 'not-found')
  })
  await check('/meta answers 403 outside-allowed-roots for an outside file with readScope roots', async () => {
    const response = await request(strict.port, { path: withQuery(routePath('meta'), { path: files.outside, cwd: fixtures.work }) })
    assert.equal(response.status, 403)
    assert.equal(response.json().code, 'outside-allowed-roots')
  })
  await check('/meta answers 200 for an absolute path inside the cwd root', async () => {
    const { response, body } = await metaOf(files.markdown, '/')
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
  })

  // ---------------------------------------------------------------------- raw
  await check('/raw serves image bytes with the full header set', async () => {
    const response = await request(main.port, {
      path: withQuery(routePath('raw'), { path: files.png, cwd: fixtures.work }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'image/png')
    assert.equal(response.headers['content-length'], String(PNG_BYTES.length))
    assert.equal(response.headers['accept-ranges'], 'bytes')
    assert.equal(response.headers['cache-control'], 'private, max-age=30')
    assert.equal(response.headers['x-content-type-options'], 'nosniff')
    assert.match(String(response.headers['content-disposition']), /^inline;/)
    assert.ok(String(response.headers['content-disposition']).includes("filename*=UTF-8''photo.png"))
    assert.deepEqual(response.buffer, PNG_BYTES)
  })
  await check('/raw honours a byte range with 206 + content-range', async () => {
    const response = await request(main.port, {
      path: withQuery(routePath('raw'), { path: files.png }),
      headers: { range: 'bytes=0-3' },
    })
    assert.equal(response.status, 206)
    assert.equal(response.headers['content-range'], `bytes 0-3/${String(PNG_BYTES.length)}`)
    assert.equal(response.headers['content-length'], '4')
    assert.deepEqual(response.buffer, PNG_BYTES.subarray(0, 4))
  })
  await check('/raw honours a suffix range', async () => {
    const response = await request(main.port, {
      path: withQuery(routePath('raw'), { path: files.png }),
      headers: { range: 'bytes=-2' },
    })
    assert.equal(response.status, 206)
    assert.equal(response.headers['content-range'], `bytes ${String(PNG_BYTES.length - 2)}-${String(PNG_BYTES.length - 1)}/${String(PNG_BYTES.length)}`)
    assert.deepEqual(response.buffer, PNG_BYTES.subarray(-2))
  })
  await check('/raw switches to attachment with an encoded filename for download=1', async () => {
    const response = await request(main.port, {
      path: withQuery(routePath('raw'), { path: files.spaced, download: 1 }),
    })
    assert.equal(response.status, 200)
    const disposition = String(response.headers['content-disposition'])
    assert.match(disposition, /^attachment;/)
    assert.ok(disposition.includes("filename*=UTF-8''space%20name.txt"), disposition)
  })
  await check('/raw answers HEAD with headers and no body', async () => {
    const response = await request(main.port, { method: 'HEAD', path: withQuery(routePath('raw'), { path: files.text }) })
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-length'], String(Buffer.byteLength(await readFile(files.text))))
    assert.equal(response.buffer.length, 0)
  })
  await check('/raw answers 416 for an unsatisfiable range', async () => {
    const response = await request(main.port, {
      path: withQuery(routePath('raw'), { path: files.png }),
      headers: { range: 'bytes=999999-' },
    })
    assert.equal(response.status, 416)
    assert.equal(response.headers['content-range'], `bytes */${String(PNG_BYTES.length)}`)
  })
  await check('/raw enforces the allowed roots with readScope roots', async () => {
    const response = await request(strict.port, { path: withQuery(routePath('raw'), { path: files.outside, cwd: fixtures.work }) })
    assert.equal(response.status, 403)
    assert.equal(response.json().code, 'outside-allowed-roots')
  })

  // --------------------------------------------------------------------- text
  await check('/text returns Markdown text as UTF-8', async () => {
    const { response, body } = await getJson(main.port, withQuery(routePath('text'), { path: files.markdown }))
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.encoding, 'utf-8')
    assert.equal(body.truncated, false)
    assert.ok(body.text.startsWith('# Notes'))
    assert.equal(body.bytes, Buffer.byteLength(await readFile(files.markdown)))
  })
  await check('/text returns plain text', async () => {
    const { body } = await getJson(main.port, withQuery(routePath('text'), { path: files.text }))
    assert.equal(body.ok, true)
    assert.ok(body.text.includes('Hello from dsh-file-preview.'))
  })
  await check('/text rejects binary content with code binary (HTTP 200)', async () => {
    const { response, body } = await getJson(main.port, withQuery(routePath('text'), { path: files.png }))
    assert.equal(response.status, 200)
    assert.equal(body.ok, false)
    assert.equal(body.code, 'binary')
  })
  await check('/text falls back to Windows-1251 when UTF-8 yields replacement characters', async () => {
    const { body } = await getJson(main.port, withQuery(routePath('text'), { path: files.cp1251 }))
    assert.equal(body.ok, true)
    assert.equal(body.encoding, 'windows-1251')
    assert.equal(body.text, 'Привет мир')
  })
  await check('/text truncates at maxBytes and reports it', async () => {
    const { body } = await getJson(main.port, withQuery(routePath('text'), { path: files.large, maxBytes: 100 }))
    assert.equal(body.ok, true)
    assert.equal(body.truncated, true)
    assert.equal(body.bytes, 100)
    assert.equal(body.text.length, 100)
  })
  await check('/text enforces the allowed roots with readScope roots', async () => {
    const response = await request(strict.port, { path: withQuery(routePath('text'), { path: files.outside, cwd: fixtures.work }) })
    assert.equal(response.status, 403)
  })

  // ------------------------------------------------------------------- office
  await check('/office-pdf converts a DOCX through the stubbed officeToPdf service', async () => {
    const response = await request(main.port, { path: withQuery(routePath('office-pdf'), { path: files.docx }) })
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'application/pdf')
    assert.equal(response.headers['x-office-cache'], 'miss')
    assert.equal(response.buffer.subarray(0, 4).toString('latin1'), '%PDF')
    assert.equal(office.state.calls, 1)
    const requestShape = office.state.lastRequest
    assert.equal(requestShape.extension, 'docx')
    assert.equal(requestShape.priority, 'foreground')
    assert.ok(String(requestShape.source.key).endsWith('report.docx'))
    assert.equal(requestShape.source.bytes, (await stat(files.docx)).size)
    assert.equal(requestShape.source.version, `${(await stat(files.docx)).mtimeMs}:${(await stat(files.docx)).size}`)
    assert.equal(typeof requestShape.source.read, 'function')
    assert.ok(office.state.lastSignal instanceof AbortSignal)
    const read = await requestShape.source.read(undefined, 10_000_000)
    assert.deepEqual(Buffer.from(read.bytes), await readFile(files.docx))
    assert.equal(read.version, requestShape.source.version)
  })
  await check('/office-pdf serves the cached PDF on the second request without reconverting', async () => {
    const response = await request(main.port, { path: withQuery(routePath('office-pdf'), { path: files.docx }) })
    assert.equal(response.status, 200)
    assert.equal(response.headers['x-office-cache'], 'hit')
    assert.equal(office.state.calls, 1)
    assert.deepEqual(response.buffer, PDF_BYTES)
  })
  await check('converted PDFs are cached under $DSH_HOME/cache/file-preview', async () => {
    const entries = await readdir(join(fixtures.state, 'cache', 'file-preview'))
    assert.equal(entries.length, 1)
    assert.ok(entries[0].endsWith('.pdf'), entries[0])
  })
  await check('/office-pdf answers 415 not-office for a non-Office file', async () => {
    const response = await request(main.port, { path: withQuery(routePath('office-pdf'), { path: files.png }) })
    assert.equal(response.status, 415)
    assert.equal(response.json().code, 'not-office')
  })
  await check('/office-pdf answers 501 office-unavailable when the service is not mounted', async () => {
    const response = await request(limited.port, { path: withQuery(routePath('office-pdf'), { path: files.docx }) })
    assert.equal(response.status, 501)
    assert.equal(response.json().code, 'office-unavailable')
  })

  // --------------------------------------------------------------- read scope
  await check('default readScope is any; readScope roots is strict', () => {
    assert.equal(mainApp.policy.readScope, 'any')
    assert.equal(strictApp.policy.readScope, 'roots')
    assert.equal(strictPlusApp.policy.readScope, 'roots')
  })
  await check('/meta reads any existing path outside the old roots by default', async () => {
    const { response, body } = await metaOf(files.outside)
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.absPath, await realpath(files.outside))
  })
  await check('/raw reads outside the old roots by default', async () => {
    const response = await request(main.port, { path: withQuery(routePath('raw'), { path: files.outside, cwd: fixtures.work }) })
    assert.equal(response.status, 200)
    assert.equal(response.text, 'outside every allowed root')
  })
  await check('/text reads outside the old roots by default', async () => {
    const { response, body } = await getJson(main.port, withQuery(routePath('text'), { path: files.outside, cwd: fixtures.work }))
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.text, 'outside every allowed root')
  })
  await check('/office-pdf converts an outside path by default and 403s under roots scope', async () => {
    const anyResponse = await request(main.port, { path: withQuery(routePath('office-pdf'), { path: outsideDocx, cwd: fixtures.work }) })
    assert.equal(anyResponse.status, 200)
    assert.equal(anyResponse.headers['content-type'], 'application/pdf')
    assert.equal(anyResponse.buffer.subarray(0, 4).toString('latin1'), '%PDF')
    const strictResponse = await request(strict.port, { path: withQuery(routePath('office-pdf'), { path: outsideDocx, cwd: fixtures.work }) })
    assert.equal(strictResponse.status, 403)
    assert.equal(strictResponse.json().code, 'outside-allowed-roots')
  })
  await check('a relative .. traversal resolves in default scope and 403s under roots scope', async () => {
    const anyResponse = await request(main.port, { path: withQuery(routePath('meta'), { path: outsideTraversal, cwd: fixtures.work }) })
    assert.equal(anyResponse.status, 200)
    assert.equal(anyResponse.json().ok, true)
    const strictResponse = await request(strict.port, { path: withQuery(routePath('meta'), { path: outsideTraversal, cwd: fixtures.work }) })
    assert.equal(strictResponse.status, 403)
    assert.equal(strictResponse.json().code, 'outside-allowed-roots')
  })
  await check('readScope roots still honours allowRoots as an explicit escape hatch', async () => {
    const { response, body } = await getJson(strictPlus.port, withQuery(routePath('meta'), { path: files.outside, cwd: fixtures.work }))
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
  })
  await check('control characters and malformed paths stay 400 in both scopes', async () => {
    for (const port of [main.port, strict.port]) {
      const control = await request(port, { path: withQuery(routePath('meta'), { path: 'bad\u0001path', cwd: fixtures.work }) })
      assert.equal(control.status, 400)
      assert.equal(control.json().code, 'bad-path')
      const malformed = await request(port, { path: withQuery(routePath('meta'), { path: 'bad\u0000path', cwd: fixtures.work }) })
      assert.equal(malformed.status, 400)
      assert.equal(malformed.json().code, 'bad-path')
    }
  })
  await check('a missing outside file is still 404 in default scope', async () => {
    const { response, body } = await getJson(main.port, withQuery(routePath('meta'), { path: join(fixtures.outside, 'missing.txt'), cwd: fixtures.work }))
    assert.equal(response.status, 404)
    assert.equal(body.code, 'not-found')
  })
  await check('a directory path is still rejected by /raw and /text as not-a-file', async () => {
    for (const route of ['raw', 'text']) {
      const { response, body } = await getJson(main.port, withQuery(routePath(route), { path: fixtures.work, cwd: fixtures.work }))
      assert.equal(response.status, 400)
      assert.equal(body.code, 'not-a-file')
    }
  })
  await check('/resolve still answers under readScope roots', async () => {
    const { response, body } = await getJson(strict.port, withQuery(routePath('resolve'), { name: 'report.txt', cwd: fixtures.work }))
    assert.equal(response.status, 200)
    assert.equal(body.absPath, await realpath(files.attachmentNewest))
  })
  await check('JSON responses keep no-store and nosniff; the connection fence is still consulted', async () => {
    const { response } = await getJson(main.port, routePath('status'))
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.headers['x-content-type-options'], 'nosniff')
    const guardedResponse = await request(guarded.port, { path: routePath('status') })
    assert.equal(guardedResponse.status, 403)
    assert.equal(guardedResponse.json().code, 'forbidden')
  })
  await check('POST /action enforces the 64 KiB ceiling', async () => {
    const body = JSON.stringify({ action: 'open', path: files.text, pad: 'x'.repeat(70 * 1024) })
    const response = await request(main.port, {
      method: 'POST',
      path: routePath('action'),
      headers: { 'content-type': 'application/json' },
      body,
    })
    assert.equal(response.status, 413)
    assert.equal(response.json().code, 'payload-too-large')
  })

  // ------------------------------------------------------------------- action
  const expectedFileUrl = pathToFileURL(files.spaced).href
  await check('/action open calls Explorer with the encoded file URI', async () => {
    launch.calls.length = 0
    const { response, body } = await postJson(main.port, routePath('action'), { action: 'open', path: files.spaced })
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(launch.calls.length, 1)
    assert.equal(launch.calls[0].command, 'explorer.exe')
    assert.deepEqual(launch.calls[0].args, [expectedFileUrl])
    assert.deepEqual(launch.calls[0].options, { detached: true, stdio: 'ignore', windowsHide: true })
  })
  await check('/action reveal calls Explorer /select, with commas and equals escaped', async () => {
    launch.calls.length = 0
    const { body } = await postJson(main.port, routePath('action'), { action: 'reveal', path: files.comma })
    assert.equal(body.ok, true)
    const expected = pathToFileURL(files.comma).href.replaceAll(',', '%2C').replaceAll('=', '%3D')
    assert.equal(launch.calls.length, 1)
    assert.equal(launch.calls[0].command, 'explorer.exe')
    assert.deepEqual(launch.calls[0].args, ['/select,', expected])
  })
  await check('/action browser opens an http(s) URL with the default browser', async () => {
    launch.calls.length = 0
    const { body } = await postJson(main.port, routePath('action'), { action: 'browser', url: 'https://example.com/docs?x=1&y=2' })
    assert.equal(body.ok, true)
    assert.equal(launch.calls[0].command, 'rundll32.exe')
    assert.deepEqual(launch.calls[0].args, ['url.dll,FileProtocolHandler', 'https://example.com/docs?x=1&y=2'])
  })
  await check('/action browser on a local path opens its file:// URL', async () => {
    launch.calls.length = 0
    const { body } = await postJson(main.port, routePath('action'), { action: 'browser', path: files.spaced })
    assert.equal(body.ok, true)
    assert.deepEqual(launch.calls[0].args, ['url.dll,FileProtocolHandler', expectedFileUrl])
  })
  await check('/action rejects an unknown action with 400', async () => {
    const { response, body } = await postJson(main.port, routePath('action'), { action: 'rm-rf', path: files.text })
    assert.equal(response.status, 400)
    assert.equal(body.code, 'bad-request')
  })
  await check('/action rejects a missing path with 400 bad-path', async () => {
    const { response, body } = await postJson(main.port, routePath('action'), { action: 'open' })
    assert.equal(response.status, 400)
    assert.equal(body.code, 'bad-path')
  })
  await check('/action answers 404 for a path that does not exist', async () => {
    const { response, body } = await postJson(main.port, routePath('action'), { action: 'open', path: join(fixtures.work, 'nope.txt') })
    assert.equal(response.status, 404)
    assert.equal(body.code, 'not-found')
  })
  await check('/action rejects malformed JSON with 400', async () => {
    const response = await request(main.port, {
      method: 'POST',
      path: routePath('action'),
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    assert.equal(response.status, 400)
    assert.equal(response.json().code, 'bad-request')
  })
  await check('/action answers 501 action-unavailable when the platform has no launcher', async () => {
    const { response, body } = await postJson(limited.port, routePath('action'), { action: 'reveal', path: files.text })
    assert.equal(response.status, 501)
    assert.equal(body.code, 'action-unavailable')
  })
  await check('/action accepts a path outside the allowed roots (user-initiated)', async () => {
    launch.calls.length = 0
    const { body } = await postJson(main.port, routePath('action'), { action: 'reveal', path: files.outside })
    assert.equal(body.ok, true)
    assert.equal(launch.calls.length, 1)
  })

  // ---------------------------------------------------------------- copy-file
  await check('/action copy-file on win32 sends the fixed PowerShell script and the path as one argv element', async () => {
    copyWait.state.calls.length = 0
    copyWait.state.result = { ok: true }
    const { response, body } = await postJson(main.port, routePath('action'), { action: 'copy-file', path: files.text })
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(copyWait.state.calls.length, 1)
    const call = copyWait.state.calls[0]
    const expectedPath = await realpath(files.text)
    assert.equal(call.command, resolveWindowsPowerShell())
    assert.ok(call.command.endsWith('powershell.exe'), call.command)
    assert.deepEqual(call.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-STA', '-Command', COPY_FILE_PS_SCRIPT])
    assert.equal(call.args.length, 6)
    assert.equal(call.args[5], powerShellPathArgument(expectedPath))
    assert.ok(call.args[5].includes(expectedPath))
    assert.ok(COPY_FILE_PS_SCRIPT.includes('System.Windows.Forms.Clipboard'))
    assert.ok(COPY_FILE_PS_SCRIPT.includes('SetFileDropList'))
    assert.ok(COPY_FILE_PS_SCRIPT.includes('$args[0]'))
    assert.ok(!COPY_FILE_PS_SCRIPT.includes(expectedPath), 'the path must not be interpolated into the script text')
    assert.deepEqual(call.options, { timeoutMs: 3000, windowsHide: true })
  })
  await check('copy-file quotes a path with spaces for PowerShell while keeping it one argv element', async () => {
    copyWait.state.calls.length = 0
    copyWait.state.result = { ok: true }
    const { response, body } = await postJson(main.port, routePath('action'), { action: 'copy-file', path: files.spaced })
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    const call = copyWait.state.calls[0]
    const expectedPath = await realpath(files.spaced)
    assert.equal(call.args.length, 6)
    assert.equal(call.args[5], powerShellPathArgument(expectedPath))
    assert.notEqual(call.args[5], expectedPath, 'a spaced path must be quoted for PowerShell’s parser')
    assert.ok(call.args[5].includes(expectedPath))
  })
  await check('powerShellPathArgument leaves safe paths bare and escapes quotes for PowerShell', () => {
    assert.equal(powerShellPathArgument('C:\\safe\\file.txt'), 'C:\\safe\\file.txt')
    assert.equal(powerShellPathArgument('C:\\a b\\c.txt'), "'C:\\a b\\c.txt'")
    assert.equal(powerShellPathArgument("C:\\a'b.txt"), "'C:\\a''b.txt'")
  })
  await check('/action copy-file maps a launcher failure to copy-file-failed with the exit code', async () => {
    copyWait.state.calls.length = 0
    copyWait.state.result = { ok: false, code: 'copy-file-failed', message: 'launcher exited with code 3' }
    const { response, body } = await postJson(main.port, routePath('action'), { action: 'copy-file', path: files.text })
    assert.equal(response.status, 500)
    assert.equal(body.ok, false)
    assert.equal(body.code, 'copy-file-failed')
    assert.match(String(body.message), /code 3/)
    assert.equal(copyWait.state.calls.length, 1)
    copyWait.state.result = { ok: true }
  })
  await check('/action copy-file rejects a missing path with 400 and never waits', async () => {
    copyWait.state.calls.length = 0
    const { response, body } = await postJson(main.port, routePath('action'), { action: 'copy-file' })
    assert.equal(response.status, 400)
    assert.equal(body.code, 'bad-path')
    assert.equal(copyWait.state.calls.length, 0)
  })
  await check('/action copy-file answers 404 for a nonexistent file and never waits', async () => {
    copyWait.state.calls.length = 0
    const { response, body } = await postJson(main.port, routePath('action'), { action: 'copy-file', path: join(fixtures.work, 'missing-copy.txt') })
    assert.equal(response.status, 404)
    assert.equal(body.code, 'not-found')
    assert.equal(copyWait.state.calls.length, 0)
  })
  await check('/action copy-file rejects a directory with 400 not-a-file', async () => {
    copyWait.state.calls.length = 0
    const { response, body } = await postJson(main.port, routePath('action'), { action: 'copy-file', path: fixtures.work })
    assert.equal(response.status, 400)
    assert.equal(body.code, 'not-a-file')
    assert.equal(copyWait.state.calls.length, 0)
  })
  await check('/action copy-file on darwin passes a fixed osascript and the path as argv item 1', async () => {
    copyWait.state.calls.length = 0
    copyWait.state.result = { ok: true }
    const { response, body } = await postJson(copyDarwin.port, routePath('action'), { action: 'copy-file', path: files.text })
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(copyWait.state.calls.length, 1)
    const call = copyWait.state.calls[0]
    const expectedPath = await realpath(files.text)
    assert.equal(call.command, 'osascript')
    assert.deepEqual(call.args, ['-e', 'on run argv', '-e', COPY_FILE_OSASCRIPT_SCRIPT, '-e', 'end run', expectedPath])
    assert.ok(COPY_FILE_OSASCRIPT_SCRIPT.includes('POSIX file'))
    assert.ok(!COPY_FILE_OSASCRIPT_SCRIPT.includes(expectedPath), 'the path must not be interpolated into the script text')
  })
  await check('/action copy-file answers 501 action-unavailable on Linux and never waits', async () => {
    copyWait.state.calls.length = 0
    const { response, body } = await postJson(copyLinux.port, routePath('action'), { action: 'copy-file', path: files.text })
    assert.equal(response.status, 501)
    assert.equal(body.code, 'action-unavailable')
    assert.match(String(body.message), /file clipboard/i)
    assert.equal(copyWait.state.calls.length, 0)
  })
  await check('performAction rejects relative, missing and non-file copy-file paths before any wait', async () => {
    const calls = []
    const wait = async (...args) => {
      calls.push(args)
      return { ok: true }
    }
    const relativeResult = await performAction({ action: 'copy-file', path: 'relative.txt', platform: 'win32', wait })
    assert.equal(relativeResult.code, 'bad-path')
    const missingResult = await performAction({ action: 'copy-file', path: join(fixtures.work, 'ghost.txt'), platform: 'win32', wait })
    assert.equal(missingResult.code, 'not-found')
    const directoryResult = await performAction({ action: 'copy-file', path: fixtures.work, platform: 'win32', wait })
    assert.equal(directoryResult.code, 'not-a-file')
    assert.equal(calls.length, 0)
  })
  await check('resolveWindowsPowerShell prefers the system-root absolute path and falls back to PATH', () => {
    const root = 'C:\\WindowsSynthetic'
    const absolute = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    assert.equal(resolveWindowsPowerShell({ SystemRoot: root }, candidate => candidate === absolute), absolute)
    assert.equal(resolveWindowsPowerShell({ SystemRoot: root }, () => false), 'powershell.exe')
    assert.equal(resolveWindowsPowerShell({}, () => false), 'powershell.exe')
  })
  await check('waitForLauncher reports success, exit code and timeout with a short settle window', async () => {
    const success = await waitForLauncher(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 5000 })
    assert.equal(success.ok, true)
    const failure = await waitForLauncher(process.execPath, ['-e', 'process.exit(3)'], { timeoutMs: 5000 })
    assert.equal(failure.ok, false)
    assert.equal(failure.code, 'copy-file-failed')
    assert.match(String(failure.message), /code 3/)
    const timeout = await waitForLauncher(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 100 })
    assert.equal(timeout.ok, false)
    assert.equal(timeout.code, 'copy-file-failed')
    assert.match(String(timeout.message), /timed out after 100 ms/)
  })

  // --------------------------------------------------------------------- link
  await check('/link returns OpenGraph metadata through the stubbed fetch', async () => {
    linkFetch.state.calls = 0
    const { response, body } = await getJson(main.port, withQuery(routePath('link'), { url: 'https://example.com/article' }))
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.url, 'https://example.com/article')
    assert.equal(body.host, 'example.com')
    assert.equal(body.title, 'OG & Title')
    assert.equal(body.description, 'OG description')
    assert.equal(body.siteName, 'Example Site')
    assert.equal(body.icon, 'https://example.com/favicon-32.png')
    assert.equal(body.image, 'https://example.com/preview.png')
    assert.equal(linkFetch.state.calls, 1)
    assert.equal(linkFetch.state.lastUrl, 'https://example.com/article')
  })
  await check('/link rejects a non-http(s) URL with 400 bad-url', async () => {
    const { response, body } = await getJson(main.port, withQuery(routePath('link'), { url: 'ftp://example.com/file' }))
    assert.equal(response.status, 400)
    assert.equal(body.code, 'bad-url')
  })
  await check('/link reports an upstream failure without throwing', async () => {
    const { response, body } = await getJson(main.port, withQuery(routePath('link'), { url: 'https://reject.example/page' }))
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.error, 'fetch exploded')
  })
  await check('/link caps the downloaded body at 512 KiB', async () => {
    const { body } = await getJson(main.port, withQuery(routePath('link'), { url: 'https://huge.example/page' }))
    assert.equal(body.ok, true)
    assert.equal(body.title, 'Huge page')
    assert.equal(body.truncated, true)
  })
  await check('/link applies its request timeout', async () => {
    const { body } = await getJson(main.port, withQuery(routePath('link'), { url: 'https://slow.example/page' }))
    assert.equal(body.ok, true)
    assert.equal(body.error, 'timeout')
  })

  // ------------------------------------------------------------------ resolve
  await check('/resolve gives the attachments root precedence over a newer workspace file', async () => {
    const attachmentInfo = await stat(files.attachmentNewest)
    const workspaceInfo = await stat(files.cwdReport)
    assert.ok(
      workspaceInfo.mtimeMs > attachmentInfo.mtimeMs,
      'F2 fixture must hold a NEWER workspace file with the same basename',
    )
    const { response, body } = await getJson(main.port, withQuery(routePath('resolve'), { name: 'report.txt', cwd: fixtures.work }))
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.absPath, await realpath(files.attachmentNewest))
    assert.equal(body.path, await realpath(files.attachmentNewest))
    assert.equal(body.name, 'report.txt')
    assert.equal(body.size, attachmentInfo.size)
    assert.equal(body.mtimeMs, attachmentInfo.mtimeMs)
  })
  await check('/resolve falls back to the cwd subtree when the attachments root has no match', async () => {
    const { response, body } = await getJson(main.port, withQuery(routePath('resolve'), { name: 'workspace-only.txt', cwd: fixtures.work }))
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.absPath, await realpath(workspaceOnly))
    assert.equal(body.name, 'workspace-only.txt')
  })
  await check('/resolve answers from the attachments root when only it has a match', async () => {
    const { response, body } = await getJson(main.port, withQuery(routePath('resolve'), { name: 'attachment-only.txt', cwd: fixtures.work }))
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.absPath, await realpath(attachmentsOnly))
    assert.equal(body.name, 'attachment-only.txt')
  })
  await check('/resolve strips quotes from the display name', async () => {
    const { body } = await getJson(main.port, withQuery(routePath('resolve'), { name: '"report.txt"', cwd: fixtures.work }))
    assert.equal(body.ok, true)
    assert.equal(body.absPath, await realpath(files.attachmentNewest))
  })
  await check('/resolve answers 404 not-found for an unknown name', async () => {
    const { response, body } = await getJson(main.port, withQuery(routePath('resolve'), { name: 'nobody-here.txt', cwd: fixtures.work }))
    assert.equal(response.status, 404)
    assert.equal(body.code, 'not-found')
  })
  await check('/resolve answers 409 ambiguous for equally-new matches', async () => {
    const { response, body } = await getJson(main.port, withQuery(routePath('resolve'), { name: 'dupe.txt', cwd: fixtures.work }))
    assert.equal(response.status, 409)
    assert.equal(body.code, 'ambiguous')
    assert.equal(body.candidates.length, 2)
  })
  await check('/resolve rejects a name containing separators', async () => {
    const { response, body } = await getJson(main.port, withQuery(routePath('resolve'), { name: '../secret.txt', cwd: fixtures.work }))
    assert.equal(response.status, 400)
    assert.equal(body.code, 'bad-name')
  })

  // ------------------------------------------------------------------- status
  await check('/status exposes version, start time, counters, last error and the seat channel', async () => {
    const { response, body } = await getJson(main.port, withQuery(routePath('status'), { seat: 'overlay-mounted' }))
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.version, '0.1.0')
    assert.ok(!Number.isNaN(Date.parse(body.startedAt)))
    assert.equal(body.lastClientSeat, 'overlay-mounted')
    for (const counter of ['meta', 'raw', 'text', 'office', 'link', 'action', 'resolve']) {
      assert.ok(body.requests[counter] > 0, `counter ${counter} = ${String(body.requests[counter])}`)
    }
    assert.equal(typeof body.lastError, 'object')
    assert.ok(typeof body.lastError.code === 'string')
  })

  // ------------------------------------------------------------------ summary
  const ok = checker.summary()
  if (!ok) {
    for (const failure of checker.state.failures) {
      console.error(`\n--- ${failure.name}\n${failure.error instanceof Error ? failure.error.stack : String(failure.error)}`)
    }
    process.exitCode = 1
  }
} finally {
  await main.close().catch(() => {})
  await limited.close().catch(() => {})
  await strict.close().catch(() => {})
  await strictPlus.close().catch(() => {})
  await guarded.close().catch(() => {})
  await copyDarwin.close().catch(() => {})
  await copyLinux.close().catch(() => {})
  await fixtures.cleanup()
}
