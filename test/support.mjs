/**
 * Unit-harness support: assertions, fixtures, a real loopback HTTP server and
 * the Electron/office/fetch stand-ins.
 *
 * Deliberately no test framework and no npm dependency: `scripts/unit-host.mjs`
 * runs on stock Node, prints one PASS line per assertion, and exits non-zero
 * on the first failed summary.
 *
 * @module dsh-file-preview/test/support
 */

import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 1x1 transparent PNG. */
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
)

/** A structurally complete (if minimal) PDF. */
export const PDF_BYTES = Buffer.from(
  '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
  'utf8',
)

/** `Привет мир` encoded as Windows-1251. */
export const CP1251_BYTES = Buffer.from([0xCF, 0xF0, 0xE8, 0xE2, 0xE5, 0xF2, 0x20, 0xEC, 0xE8, 0xF0])

/** Assertion runner: prints one PASS line per check, collects failures. */
export function createChecker() {
  const state = { passed: 0, failed: 0, failures: [] }
  return {
    state,
    async check(name, fn) {
      try {
        await fn()
        state.passed += 1
        console.log(`PASS ${name}`)
      } catch (error) {
        state.failed += 1
        state.failures.push({ name, error })
        console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    summary() {
      console.log(`\nSUMMARY ${state.passed} passed, ${state.failed} failed`)
      return state.failed === 0
    },
  }
}

/**
 * Materialize every fixture the harness needs.
 * @returns {Promise<object>} fixture paths + cleanup.
 */
export async function materializeFixtures() {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-file-preview-fixtures-'))
  const work = join(root, 'work')
  const home = join(root, 'home')
  const state = join(root, 'state')
  const attachments = join(state, 'attachments', 'v1', 'files')
  const outside = join(tmpdir(), `dsh-file-preview-outside-${String(process.pid)}-${String(Date.now())}`)
  await fsp.mkdir(work, { recursive: true })
  await fsp.mkdir(home, { recursive: true })
  await fsp.mkdir(join(attachments, 'aa', 'aaaa'), { recursive: true })
  await fsp.mkdir(join(attachments, 'bb', 'bbbb'), { recursive: true })
  await fsp.mkdir(join(attachments, 'cc', 'cccc'), { recursive: true })
  await fsp.mkdir(outside, { recursive: true })

  const write = async (path, data) => {
    await fsp.writeFile(path, data)
    return path
  }

  const files = {
    png: await write(join(work, 'photo.png'), PNG_BYTES),
    pdf: await write(join(work, 'manual.pdf'), PDF_BYTES),
    markdown: await write(join(work, 'notes.md'), '# Notes\n\n- one\n- two\n'),
    text: await write(join(work, 'sample.txt'), 'Hello from dsh-file-preview.\r\nLine two.\r\n'),
    html: await write(join(work, 'page.html'), '<!doctype html><title>Local page</title>'),
    docx: await write(join(work, 'report.docx'), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('fixture docx payload')])),
    binary: await write(join(work, 'binary.bin'), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])),
    cp1251: await write(join(work, 'cyrillic.txt'), CP1251_BYTES),
    large: await write(join(work, 'large.txt'), Buffer.from('abcdefghij'.repeat(400))),
    spaced: await write(join(work, 'space name.txt'), 'spaced name'),
    comma: await write(join(work, 'comma,name=five.txt'), 'explorer escapes commas and equals'),
    homeSample: await write(join(home, 'home-sample.txt'), 'tilde expansion'),
    outside: await write(join(outside, 'secret.txt'), 'outside every allowed root'),
    attachmentNewest: await write(join(attachments, 'aa', 'aaaa', 'report.txt'), 'newest attachment copy'),
    ambiguousOne: await write(join(attachments, 'bb', 'bbbb', 'dupe.txt'), 'dupe one'),
    ambiguousTwo: await write(join(attachments, 'cc', 'cccc', 'dupe.txt'), 'dupe two'),
    cwdReport: await write(join(work, 'report.txt'), 'older workspace copy'),
  }

  const old = new Date('2024-01-02T03:04:05.000Z')
  const older = new Date('2023-05-06T07:08:09.000Z')
  await fsp.utimes(files.cwdReport, older, older)
  await fsp.utimes(files.ambiguousOne, old, old)
  await fsp.utimes(files.ambiguousTwo, old, old)

  return {
    root,
    work,
    home,
    state,
    attachments,
    outside,
    files,
    cleanup: async () => {
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(outside, { recursive: true, force: true }).catch(() => {})
    },
  }
}

/**
 * Start one app on a loopback ephemeral port.
 * @param {object} app - host app from `createHostApp`.
 * @returns {Promise<{port: number, base: string, close: Function}>} server handle.
 */
export async function startServer(app) {
  const server = createServer((req, res) => {
    app.dispatch(req, res).catch(error => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: false, code: 'test-dispatch-failed', message: error instanceof Error ? error.message : String(error) }))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    base: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

/**
 * One raw HTTP request against the harness server.
 * @param {number} port - loopback port.
 * @param {object} [options] - request options.
 * @returns {Promise<{status: number, headers: object, buffer: Buffer, text: string, json: (() => any)}>} response.
 */
export function request(port, options = {}) {
  const method = options.method ?? 'GET'
  const path = options.path ?? '/'
  const headers = { ...(options.headers ?? {}) }
  const body = options.body
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const buffer = Buffer.concat(chunks)
        const text = buffer.toString('utf8')
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buffer,
          text,
          json: () => {
            try {
              return JSON.parse(text)
            } catch {
              return undefined
            }
          },
        })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/**
 * Build a query string, skipping null/undefined values.
 * @param {Record<string, unknown>} params - query params.
 * @returns {string} encoded query (without `?`).
 */
export function query(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    search.set(key, String(value))
  }
  return search.toString()
}

/** GET + JSON convenience. */
export async function getJson(port, pathAndQuery, headers) {
  const response = await request(port, { path: pathAndQuery, headers })
  return { response, body: response.json() }
}

/** POST JSON convenience. */
export async function postJson(port, pathAndQuery, body, headers = {}) {
  const response = await request(port, {
    method: 'POST',
    path: pathAndQuery,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { response, body: response.json() }
}

/**
 * Recorder for the OS launcher seam.
 * @returns {{calls: object[], fn: Function}} launcher stub.
 */
export function createLaunchStub() {
  const calls = []
  return {
    calls,
    fn: async (command, args, options) => {
      calls.push({ command, args, options })
    },
  }
}

/**
 * Stub of the shipped `officeToPdf` service: records the request and returns
 * a fixed PDF.
 * @param {Buffer} pdf - bytes the stub returns.
 * @returns {{state: object, service: object}} office stub.
 */
export function createOfficeStub(pdf = PDF_BYTES) {
  const state = { calls: 0, lastRequest: null, lastSignal: null }
  return {
    state,
    service: {
      async convert(request, signal) {
        state.calls += 1
        state.lastRequest = request
        state.lastSignal = signal
        return { pdf: Buffer.from(pdf), missingFonts: ['Stub Font'], cacheKey: 'stub-cache', generation: 7 }
      },
    },
  }
}

/** HTML the link stub serves. */
const STUB_HTML = `<!doctype html>
<html><head>
<title>Fallback title</title>
<meta name="description" content="Plain description">
<meta property="og:title" content="OG &amp; Title">
<meta property="og:description" content="OG description">
<meta property="og:site_name" content="Example Site">
<meta property="og:image" content="/preview.png">
<link rel="icon" href="/favicon-32.png">
</head><body>hello</body></html>`

/**
 * Fetch seam for `/link`: serves {@link STUB_HTML}, rejects on
 * `reject.example`, and hangs (until aborted) on `slow.example`.
 * @returns {{state: object, fn: Function}} fetch stub.
 */
export function createLinkFetchStub() {
  const state = { calls: 0, lastUrl: null }
  return {
    state,
    fn: async (url, init) => {
      state.calls += 1
      state.lastUrl = url
      if (String(url).includes('reject.example')) throw new Error('fetch exploded')
      if (String(url).includes('huge.example')) {
        const page = `<html><head><title>Huge page</title></head><body>${'x'.repeat(600 * 1024)}</body></html>`
        return new Response(page, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      if (String(url).includes('slow.example')) {
        return new Promise((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      }
      return new Response(STUB_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    },
  }
}

/** Whether a path exists (fixture sanity). */
export function exists(path) {
  return existsSync(path)
}

/** Assertion re-export. */
export { assert }
