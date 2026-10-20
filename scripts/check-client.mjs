/**
 * check-client.mjs — static verification of the `dsh-file-preview` browser half.
 *
 * The client is one hand-authored bundle with no build step, so the cheap
 * regression net is a set of textual/structural assertions over `lib/client.js`
 * plus the two locale dictionaries. Every assertion prints one PASS line; any
 * failure prints FAIL and the process exits 1.
 *
 * Usage: node scripts/check-client.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = join(root, 'lib', 'client.js')
const enPath = join(root, 'locale', 'en.json')
const ruPath = join(root, 'locale', 'ru.json')
const pkgPath = join(root, 'package.json')

const source = readFileSync(clientPath, 'utf8')
const packageName = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')).name : 'dsh-file-preview'
const NS = 'dsh-file-preview'

let passed = 0
let failed = 0

/**
 * Print one assertion result.
 * @param id - stable assertion id.
 * @param description - what is being proven.
 * @param condition - the assertion outcome.
 * @param detail - failure detail.
 */
function assert(id, description, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`PASS ${id} — ${description}`)
    return true
  }
  failed += 1
  console.log(`FAIL ${id} — ${description}${detail === undefined ? '' : `\n     ${detail}`}`)
  return false
}

/** Slice the JSON object between two locale markers. */
function localeBlock(name) {
  const begin = `/* locale:${name}:begin */`
  const end = `/* locale:${name}:end */`
  const start = source.indexOf(begin)
  const stop = source.indexOf(end)
  if (start === -1 || stop === -1 || stop < start) throw new Error(`locale markers missing for ${name}`)
  return source.slice(start + begin.length, stop).trim()
}

/** Compare two dictionaries by canonical JSON. */
function sameDictionary(left, right) {
  const canonical = (value) => JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]))
  return canonical(left) === canonical(right)
}

//#region Bundle shape
const loaderCalls = source.split('window.__ModuleLoader__.load(').length - 1
assert('bundle-single-loader', 'exactly one window.__ModuleLoader__.load call', loaderCalls === 1, `found ${loaderCalls}`)

const factoryId = /window\.__ModuleLoader__\.load\(\{[\s\S]{0,80}?id:\s*'([^']+)'/.exec(source)
assert(
  'factory-id',
  `factory id equals the package name (${packageName})`,
  factoryId !== null && factoryId[1] === packageName,
  `factory id: ${factoryId === null ? 'missing' : factoryId[1]}`
)

const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
const harnessRequires = requires.filter((specifier) => specifier.startsWith('@deepseek-ai/'))
assert('no-harness-requires', 'no Harness client package is required', harnessRequires.length === 0, harnessRequires.join(', '))
assert(
  'react-only-require',
  'the only module required is react',
  requires.length > 0 && requires.every((specifier) => specifier === 'react'),
  requires.join(', ')
)

const factoryStart = source.indexOf('factory(require) {')
const helpersStart = source.indexOf('//#region Pure helpers')
const dataRegionRaw = factoryStart === -1 || helpersStart === -1 ? '' : source.slice(factoryStart, helpersStart)
// Dictionary values are data, not behaviour: drop both locale blocks first.
const dataRegionCode = dataRegionRaw.replace(/\/\* locale:[a-z]{2}:begin \*\/[\s\S]*?\/\* locale:[a-z]{2}:end \*\//g, '')
// Comments describe behaviour; only executable text counts as a side effect.
const dataRegion = dataRegionCode
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n')
const banned = ['window.', 'document.', 'addEventListener', 'setTimeout', 'setInterval', 'localStorage', 'fetch(', 'new ']
const foundBanned = banned.filter((needle) => dataRegion.includes(needle))
assert(
  'factory-pure',
  'the factory only assembles data before any behaviour (no side effect at factory level)',
  factoryStart !== -1 && helpersStart > factoryStart && foundBanned.length === 0,
  foundBanned.join(', ')
)

const applyIndex = source.indexOf('function apply(ctx)')
assert('apply-present', 'the plugin exports an apply(ctx) function', applyIndex !== -1)

const listenerSites = [...source.matchAll(/addEventListener\(/g)].map((match) => match.index)
assert(
  'listeners-after-apply',
  'every event listener is created inside apply() or in code installed by it',
  applyIndex !== -1 && listenerSites.length > 0 && listenerSites.every((index) => index > applyIndex),
  `sites: ${listenerSites.join(', ')}, apply at ${applyIndex}`
)
//#endregion

//#region Interception
const captureClick = /window\.addEventListener\('click',\s*runtime\.onClickCapture,\s*true\)/.test(source)
assert('capture-click', 'a capture-phase window click listener is installed', captureClick)

const passiveAux = /window\.addEventListener\('auxclick',\s*runtime\.onAuxClick,\s*\{\s*capture:\s*true,\s*passive:\s*true\s*\}\)/.test(source)
assert('auxclick-bypass', 'a passive auxclick listener lets the application keep middle/right clicks', passiveAux)

const effectLabel = "}, 'dsh-file-preview: window interception')"
const effectLabelIndex = source.indexOf(effectLabel)
const removeSites = [...source.matchAll(/window\.removeEventListener\('(click|auxclick)'/g)].map((match) => match.index)
assert(
  'listener-cleanup-effect',
  'both listeners are removed by the ctx.effect disposer before the effect label',
  applyIndex !== -1 &&
    effectLabelIndex > applyIndex &&
    removeSites.length >= 2 &&
    removeSites.every((index) => index > applyIndex && index < effectLabelIndex) &&
    /ctx\.effect\(function \(\) \{[\s\S]{0,4000}?window\.addEventListener\('click'/.test(source)
)

assert(
  'interception-rules',
  'modifier clicks, auxclick and clicks inside the plugin root are left to the application',
  /event\.metaKey \|\| event\.ctrlKey \|\| event\.altKey \|\| event\.shiftKey/.test(source) &&
    /event\.button !== 0/.test(source) &&
    /path\.indexOf\(rootEl\) !== -1/.test(source) &&
    /event\.preventDefault\(\)[\s\S]{0,120}?event\.stopPropagation\(\)/.test(source)
)

const classifyStart = source.indexOf('function classifyTarget(target)')
const classifyBody = classifyStart === -1 ? '' : source.slice(classifyStart, classifyStart + 5200)
assert(
  'interception-targets',
  'anchors, images, presented-file cards, markdown file links and user attachment cards are classified',
  classifyBody.includes("closest('a[href]')") &&
    classifyBody.includes("closest('img[src]')") &&
    classifyBody.includes("closest('[data-presented-file]')") &&
    classifyBody.includes('file(?:Link|Mention)') &&
    classifyBody.includes("closest('[data-message-attachments]')") &&
    classifyBody.includes("closest('[data-changed-files]')") === false
)
//#endregion

//#region Overlay entry and routes
assert(
  'overlay-slot',
  'a shell.overlay entry is registered through ctx.slots.inject with a fresh id',
  /ctx\.slots\.inject\('shell\.overlay'/.test(source) &&
    /name:\s*'shell\.overlay'/.test(source) &&
    /const OVERLAY_ID = '([^']+)'/.exec(source) !== null &&
    /order:\s*40/.test(source)
)
const overlayId = /const OVERLAY_ID = '([^']+)'/.exec(source)
const shippedOverlayIds = [
  'chat.quota-notice',
  'plugin-manager.refresh-toast',
  'schedule.delete-toast',
  'desktop-onboarding',
  'account.platform-page',
  'host-release-change',
  'session-log-upload-toast',
  'shortcuts',
  'workspace.session-rename',
  'workspace.session-archive',
  'workspace.row-toast'
]
assert(
  'overlay-fresh-id',
  'the overlay id does not collide with a shipped shell.overlay entry',
  overlayId !== null && shippedOverlayIds.indexOf(overlayId[1]) === -1,
  overlayId === null ? 'no OVERLAY_ID' : overlayId[1]
)

const routes = ['/meta', '/raw', '/text', '/office-pdf', '/link', '/action', '/status']
const usedRoutes = [
  "apiUrl('meta'",
  "apiUrl('raw'",
  "apiUrl('text'",
  "apiUrl('officePdf'",
  "apiUrl('link'",
  "apiUrl('action'",
  "apiUrl('status'"
]
assert(
  'host-routes',
  'all seven host routes are declared and used',
  routes.every((route) => source.includes(`'${route}'`)) && usedRoutes.every((call) => source.includes(call)),
  routes.filter((route) => !source.includes(`'${route}'`)).join(', ')
)
assert(
  'seat-mounted',
  'the client announces itself with seat=mounted on boot',
  source.includes("apiUrl('status', { seat: 'mounted' })")
)
assert(
  'attachment-resolve',
  'attachment cards resolve a display name through the host /resolve route before giving up',
  source.includes("apiUrl('resolve', { name: name")
)

const actions = ['open', 'reveal', 'browser', 'copy-path', 'copy-text', 'copy-image']
assert(
  'actions-six',
  'all six host actions are implemented',
  actions.every((action) => source.includes(`'${action}'`)),
  actions.filter((action) => !source.includes(`'${action}'`)).join(', ')
)
//#endregion

//#region Hover modes
const peekDelay = /const PEEK_DELAY_MS = (\d+)/.exec(source)
const fullDelay = /const FULL_DELAY_MS = (\d+)/.exec(source)
const grace = /const PEEK_GRACE_MS = (\d+)/.exec(source)
const fade = /const PEEK_FADE_MS = (\d+)/.exec(source)
assert(
  'hover-modes',
  'peek, full and off exist, persist in localStorage and use the HoverCard timings',
  /const PEEK_MODES = \['peek', 'full', 'off'\]/.test(source) &&
    /const STORAGE_HOVER = 'dsh-file-preview\.hover-mode'/.test(source) &&
    /localStorage\.setItem\(STORAGE_HOVER, mode\)/.test(source) &&
    peekDelay !== null &&
    Number(peekDelay[1]) >= 300 &&
    Number(peekDelay[1]) <= 400 &&
    fullDelay !== null &&
    Number(fullDelay[1]) >= 400 &&
    Number(fullDelay[1]) <= 500 &&
    grace !== null &&
    Number(grace[1]) >= 100 &&
    Number(grace[1]) <= 200 &&
    fade !== null &&
    Number(fade[1]) === 100,
  `peek=${peekDelay && peekDelay[1]} full=${fullDelay && fullDelay[1]} grace=${grace && grace[1]} fade=${fade && fade[1]}`
)
assert(
  'hover-single-controller',
  'one hover controller owns one timer, one anchor and one card',
  /const hover = \{/.test(source) &&
    /function schedulePeek\(element\)/.test(source) &&
    /function dismissPeek\(/.test(source) &&
    /function keepPeek\(\)/.test(source) &&
    /function armClose\(\)/.test(source) &&
    (source.split('const peekStore = createStore(').length - 1) === 1 &&
    (source.split('const overlayStore = createStore(').length - 1) === 1
)
assert(
  'hover-local-only',
  'hover never triggers on http(s) anchors or on the shipped changed-files diff card',
  /descriptor\.kind === 'web'\) return null/.test(source) &&
    /closest\('\[data-changed-files\]'\) !== null\) return null/.test(source)
)
assert(
  'hover-dismiss-rules',
  'hover closes on leave, Escape, scroll, pointer down, resize and route changes',
  /function onPointerOut\(event\)/.test(source) &&
    /function onHoverKeyDown\(event\)/.test(source) &&
    /function onScroll\(event\)/.test(source) &&
    /function onPointerDown\(event\)/.test(source) &&
    /function onResize\(\)/.test(source) &&
    /function onRouteChange\(\)/.test(source) &&
    /window\.addEventListener\('popstate'/.test(source)
)
assert(
  'hover-watchdog',
  'hover dismissal is deterministic: a 200 ms pointer-move watchdog over anchor+card geometry, plus window blur and document mouseleave, installed and removed (negative control: without armWatchdog the card survives a single pointermove)',
  /const PEEK_WATCHDOG_MS = 200/.test(source) &&
    /function onPointerMove\(event\)/.test(source) &&
    /function armWatchdog\(\)/.test(source) &&
    /function cancelWatchdog\(\)/.test(source) &&
    /function overHoverTargets\(x, y\)/.test(source) &&
    /function onWindowBlur\(\)/.test(source) &&
    /function onDocumentMouseLeave\(\)/.test(source) &&
    source.includes("window.addEventListener('pointermove', runtime.onPointerMove") &&
    source.includes("window.addEventListener('blur', runtime.onWindowBlur") &&
    source.includes("document.addEventListener('mouseleave', runtime.onDocumentMouseLeave") &&
    source.includes("window.removeEventListener('pointermove', runtime.onPointerMove") &&
    source.includes("window.removeEventListener('blur', runtime.onWindowBlur") &&
    source.includes("document.removeEventListener('mouseleave', runtime.onDocumentMouseLeave")
)
assert(
  'hover-target-grace',
  'a pointermove whose target is neither the anchor nor the card arms the short close grace; the watchdog stays as the second net (negative control: removing the target check fails runtime-peek-target-grace)',
  /function onPointerMove\(event\)[\s\S]{0,1200}?pointerRelatedToHover\(event\.target\)[\s\S]{0,300}?armClose\(\)/.test(source) &&
    /function pointerRelatedToHover\(element\)/.test(source)
)
assert(
  'hover-target-poll',
  'while a card is open a 150 ms interval re-checks document.elementFromPoint and closes after two unrelated ticks (negative control: without the interval nothing closes a stationary pointer)',
  /const PEEK_POLL_MS = 150/.test(source) &&
    /const PEEK_POLL_MISSES = 2/.test(source) &&
    /function pollHover\(\)/.test(source) &&
    /document\.elementFromPoint\(/.test(source) &&
    source.includes('window.setInterval(pollHover, PEEK_POLL_MS)') &&
    source.includes('window.clearInterval(hover.poll)')
)
assert(
  'hover-reopen-cooldown',
  'a dismissal sets a ~400 ms cooldown that schedulePeek and showPeek honour (negative control: without it the unmount pointerover reopens the card)',
  /const REOPEN_COOLDOWN_MS = 400/.test(source) &&
    /hover\.suppressUntil = Date\.now\(\) \+ REOPEN_COOLDOWN_MS/.test(source) &&
    /Date\.now\(\) < hover\.suppressUntil\) return/.test(source)
)
assert(
  'hover-dismiss-idempotent',
  'dismissal is idempotent: a fade plus an independent hard finalizer always end at an empty store (negative control: repeated dismissals used to cancel the pending null)',
  /function schedulePeekFinalizer\(\)/.test(source) &&
    /hover\.fadeHard = window\.setTimeout/.test(source) &&
    /if \(peekStore\.get\(\) !== null\) peekStore\.set\(null\)/.test(source)
)
assert(
  'copy-file-cold-retry',
  'a cold-start copy-file timeout is retried exactly once after 150 ms; any other failure is shown immediately (negative control: removing the retry fails runtime-copy-file-cold-retry)',
  /const COPY_FILE_RETRY_MS = 150/.test(source) &&
    source.includes("code === 'copy-file-failed'") &&
    source.includes('timeout/i.test(message)') &&
    source.includes("postAction('copy-file', { path: target.path })")
)
assert(
  'error-card-diagnosable',
  'every failure card names its code; not-found/denied/outside-allowed-roots also name the middle-truncated requested path, and outside-allowed-roots points at readScope (negative control: dropping the path line fails runtime-error-path)',
  /function errorView\(t, code, retry, requestedPath\)/.test(source) &&
    /const PATH_FAILURE_CODES = \[/.test(source) &&
    source.includes("t('state.code', { code: failure })") &&
    source.includes("t('state.requestedPath', { path: middleTruncate(requestedPath, 38, 26) })") &&
    source.includes("t('state.readScopeHint')") &&
    source.includes("t('state.code', { code: 'host-missing' })") &&
    source.includes("t('state.code', { code: 'image-decode' })")
)
assert(
  'markdown-crlf',
  'the markdown renderer normalizes CRLF before line parsing (negative control: without it a CRLF heading line is not recognized)',
  source.includes(".replace(/\\r\\n?/g, '\\n')")
)
assert(
  'hover-card-interactive',
  'a pointerdown or scroll inside the hover card never dismisses it; only the outside does',
  /function onPointerDown\(event\)[\s\S]{0,700}?popoverEl !== null[\s\S]{0,400}?path\.indexOf\(popoverEl\) !== -1\) return/.test(source) &&
    /function onScroll\(event\)[\s\S]{0,600}?popoverEl !== null[\s\S]{0,400}?path\.indexOf\(popoverEl\) !== -1\) return/.test(source) &&
    !/function onPointerDown\(\)/.test(source)
)
//#endregion

//#region Locale
assert(
  'locale-register',
  'the dsh-file-preview namespace is registered for en and ru through ctx.locale',
  source.includes("ctx.locale.register(NS, 'en', EN)") && source.includes("ctx.locale.register(NS, 'ru', RU)")
)

const en = JSON.parse(localeBlock('en'))
const ru = JSON.parse(localeBlock('ru'))
const enKeys = Object.keys(en).sort()
const ruKeys = Object.keys(ru).sort()
assert(
  'locale-parity',
  'the en and ru dictionaries have the same keys',
  enKeys.length === ruKeys.length && enKeys.every((key, index) => key === ruKeys[index]),
  `en=${enKeys.length} ru=${ruKeys.length}`
)

const usedKeys = new Set([...source.matchAll(/\bt\(\s*'([a-zA-Z][a-zA-Z0-9._-]*)'/g)].map((match) => match[1]))
const missingKeys = [...usedKeys].filter((key) => en[key] === undefined || ru[key] === undefined)
assert(
  'locale-complete',
  `every one of the ${usedKeys.size} literal translation keys exists in both dictionaries`,
  missingKeys.length === 0,
  missingKeys.join(', ')
)
const emptyValues = enKeys.filter((key) => typeof en[key] !== 'string' || en[key] === '' || typeof ru[key] !== 'string' || ru[key] === '')
assert('locale-values', 'no dictionary value is empty or non-string', emptyValues.length === 0, emptyValues.join(', '))

const enFile = JSON.parse(readFileSync(enPath, 'utf8'))
const ruFile = JSON.parse(readFileSync(ruPath, 'utf8'))
assert('locale-file-en', 'locale/en.json is the embedded English dictionary', sameDictionary(en, enFile))
assert('locale-file-ru', 'locale/ru.json is the embedded Russian dictionary', sameDictionary(ru, ruFile))

const ruBegin = source.indexOf('/* locale:ru:begin */')
const ruEnd = source.indexOf('/* locale:ru:end */')
const withoutRu = source.slice(0, ruBegin) + source.slice(ruEnd + '/* locale:ru:end */'.length)
const cyrillicOutside = /[\u0400-\u04FF]/.test(withoutRu)
assert(
  'no-cyrillic-outside-locale',
  'Cyrillic only exists inside the ru dictionary block (no hard-coded Russian UI text)',
  !cyrillicOutside
)
const hardcodedRu = enKeys.filter((key) => /[\u0400-\u04FF]/.test(en[key]))
assert('locale-en-clean', 'the English dictionary holds no Cyrillic', hardcodedRu.length === 0, hardcodedRu.join(', '))

const hotkeyLabels = ['key.ctrlC', 'key.ctrlB', 'key.ctrlE', 'key.enter', 'key.esc', 'key.cmdC', 'key.cmdB', 'key.cmdE']
assert(
  'locale-hotkeys',
  'the hotkey labels are localized in both dictionaries',
  hotkeyLabels.every((key) => typeof en[key] === 'string' && typeof ru[key] === 'string')
)
//#endregion

//#region Chrome, accessibility and states
const cssStart = source.indexOf('const CSS = `')
const cssEnd = source.indexOf('`\n    //#endregion', cssStart)
const css = cssStart === -1 || cssEnd === -1 ? '' : source.slice(cssStart, cssEnd)
const hexColors = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0])
const functionColors = [...css.matchAll(/\b(?:rgba?|hsla?)\(/g)].map((match) => match[0])
const cssVariables = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1])
const foreignVariables = cssVariables.filter((name) => !name.startsWith('--dsw-') && !name.startsWith('--ds-'))
assert(
  'theme-tokens-only',
  'the stylesheet uses theme tokens for every colour',
  css !== '' && hexColors.length === 0 && functionColors.length === 0 && foreignVariables.length === 0,
  [...hexColors, ...functionColors, ...foreignVariables].join(', ')
)
assert(
  'peek-close-placement',
  'the peek close button is pinned to the card top-right corner via CSS (negative control: without the rule it would flow inline)',
  css.includes('.dfp-peek-close{position:absolute') && css.includes('inset-block-start:6px') && css.includes('inset-inline-end:6px')
)
assert(
  'chrome-geometry',
  'the panel is capped at min(1200px,92vw) x min(900px,88vh) with blurred, animated backdrop',
  css.includes('width:min(1200px,92vw)') &&
    css.includes('max-height:min(900px,88vh)') &&
    css.includes('backdrop-filter:blur(14px)') &&
    css.includes('animation:dfp-panel-in 200ms') &&
    css.includes('dfp-panel-out 140ms')
)
assert(
  'reduced-motion',
  'prefers-reduced-motion disables the enter/exit animation and the hover fade',
  css.includes('@media (prefers-reduced-motion: reduce)') && /prefers-reduced-motion[\s\S]{0,400}?animation:none/.test(css)
)
assert(
  'dialog-a11y',
  'the panel is role=dialog, aria-modal=true, labelled by the title',
  /role:\s*'dialog'/.test(source) && /'aria-modal':\s*'true'/.test(source) && /'aria-labelledby':\s*TITLE_ID/.test(source) && /tabIndex:\s*-1/.test(source)
)
assert(
  'focus-trap',
  'Tab is trapped inside the panel and focus returns to the invoking element',
  source.includes("key === 'Tab'") &&
    source.includes('querySelectorAll(FOCUSABLE)') &&
    /restore\.focus\(\{ preventScroll: true \}\)/.test(source) &&
    source.includes("panel.querySelector('[data-modal-autofocus]')")
)
assert(
  'hotkeys',
  'Esc, Enter, Ctrl/Cmd+C, Ctrl/Cmd+B, Ctrl/Cmd+E and the image keys are handled',
  source.includes("key === 'Escape'") &&
    source.includes("key === 'Enter'") &&
    source.includes("code === 'c'") &&
    source.includes("code === 'b'") &&
    source.includes("code === 'e'") &&
    source.includes("key === '+'") &&
    source.includes("key === '0'") &&
    source.includes("key === 'ArrowLeft'") &&
    source.includes("key === 'ArrowRight'") &&
    source.includes("key === 'ArrowUp'") &&
    source.includes("key === 'ArrowDown'")
)
assert(
  'loading-state',
  'a skeleton is rendered while metadata loads',
  source.includes('dfp-skeleton') && /if \(metaState\.phase === 'loading'\)/.test(source)
)
assert(
  'error-retry',
  'failures render an inline error card with a retry action',
  source.includes('function errorView(') && source.includes("t('state.retry')") && source.includes('onAction: retry')
)
assert(
  'restart-hint',
  'a non-plugin host answer maps to the DSH restart hint',
  source.includes("phase: 'hostMissing'") && source.includes("t('state.restartTitle')") && source.includes("t('state.restartBody')")
)
assert(
  'viewer-coverage',
  'every required viewer exists',
  source.includes('function ImageViewer(') &&
    source.includes('function DocumentFrame(') &&
    source.includes('function OfficeFrame(') &&
    source.includes('function TextPanel(') &&
    source.includes('function MediaPlayer(') &&
    source.includes('function WebsiteCard(') &&
    source.includes('function FileCard(') &&
    source.includes('function renderMarkdown(') &&
    source.includes('function RemoteImage(')
)
assert(
  'image-zoom',
  'image zoom is clamped to 25–800 % with wheel, drag pan and double-click toggle',
  source.includes('const ZOOM_MIN = 0.25') &&
    source.includes('const ZOOM_MAX = 8') &&
    source.includes("addEventListener('wheel'") &&
    source.includes('setPointerCapture') &&
    source.includes('onDoubleClick: toggle')
)
assert(
  'image-src-stage',
  'URL-backed images (blob/data/http) reuse the very same zoom/pan/fit stage as files',
  /function RemoteImage\(props\)[\s\S]{0,400}?h\(ImageViewer, \{ runtime: props\.runtime, src: props\.src, name: name \}\)/.test(source) &&
    /const directSrc = typeof props\.src === 'string'/.test(source) &&
    /directSrc === '' \? 'image:' \+ path : 'image-src:' \+ directSrc/.test(source)
)
assert(
  'host-enum-localized',
  'host enum values are mapped through the locale dictionary and never rendered verbatim',
  /function kindText\(kind, t\)/.test(source) &&
    /kindText\(meta\.kind, t\)/.test(source) &&
    source.includes('facts.push(kind)') &&
    !/facts\.push\([^)]*\bmeta\.kind\b/.test(source) &&
    source.includes("t('viewer.kindFile')") &&
    source.includes("t('viewer.kindDirectory')") &&
    source.includes("t('viewer.kindOther')")
)
assert(
  'actions-run-through-handler',
  'the footer action bar is wired to the perform() dispatcher with disabled states',
  source.includes('function ActionBar(') &&
    source.includes('function actionPermissions(') &&
    source.includes('runtime.perform(action, target)') &&
    source.includes("disabled: enabled !== true")
)
assert(
  'error-boundary',
  'a React error boundary keeps a crash out of the slot entry',
  source.includes('class OverlayErrorBoundary extends React.Component') &&
    source.includes('static getDerivedStateFromError()') &&
    source.includes('componentDidCatch(error)') &&
    /function OverlaySeat\(props\)[\s\S]{0,200}?h\(OverlayErrorBoundary/.test(source)
)
//#endregion

//#region DOM discipline
assert(
  'no-dom-outside',
  'no DOM is written outside the plugin root (no body/appRoot mutations)',
  !source.includes('document.body.appendChild') &&
    !source.includes('document.body.innerHTML') &&
    !source.includes('document.documentElement.appendChild') &&
    !source.includes('insertAdjacentHTML') &&
    /rootEl\.appendChild\(area\)/.test(source)
)
const cursorStyles = source.split("style.setAttribute(CURSOR_ATTR, '')").length - 1
const cursorRule = /style\.textContent =\s*\n?\s*'([^']+)'/.exec(source)
const cursorRuleText = cursorRule === null ? '' : cursorRule[1]
assert(
  'cursor-rule-single',
  'the only injected chat-DOM rule is one scoped cursor rule, removable in one line',
  cursorStyles === 1 &&
    source.includes('function installCursorRule()') &&
    source.includes('style.remove()') &&
    (cursorRuleText.match(/\{/g) || []).length === 1 &&
    (cursorRuleText.match(/\}/g) || []).length === 1 &&
    cursorRuleText.includes('cursor: zoom-in'),
  cursorRuleText
)
//#endregion

//#region Runtime smoke
/**
 * Execute the real bundle against a mock DOM, a mock client context and a
 * minimal React shim. This is what proves the file is not only well-shaped but
 * actually runs: apply() installs and removes resources, the click interceptor
 * classifies the shipped chat markers, the modal renders, and the host contract
 * calls behave as specified.
 */
async function runtimeChecks() {
  const { runInThisContext } = await import('node:vm')

  class MockElement {}
  globalThis.Element = MockElement

  const matchOne = (node, selector) => {
    const match = /^([a-zA-Z]*)((?:\[[^\]]+\])*)$/.exec(selector.trim())
    if (!match) return false
    if (match[1] !== '' && node.tagName !== match[1].toUpperCase()) return false
    const attrs = match[2] === '' ? [] : match[2].match(/\[[^\]]+\]/g)
    for (const attr of attrs) {
      const inner = attr.slice(1, -1)
      const eq = inner.indexOf('=')
      if (eq === -1) {
        if (node.getAttribute(inner) === null) return false
      } else if (node.getAttribute(inner.slice(0, eq)) !== inner.slice(eq + 1).replace(/^"|"$/g, '')) return false
    }
    return true
  }
  const matchesSelector = (node, selectorList) => String(selectorList).split(',').some((selector) => matchOne(node, selector))
  const createNode = (tagName, attrs, parent) =>
    Object.assign(new MockElement(), {
      tagName: String(tagName).toUpperCase(),
      attrs: attrs === undefined ? {} : attrs,
      parentNode: parent === undefined ? null : parent,
      children: [],
      textContent: '',
      isConnected: true,
      setAttribute(name, value) {
        this.attrs[name] = value
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name) ? String(this.attrs[name]) : null
      },
      hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name)
      },
      closest(selector) {
        let current = this
        while (current !== null && current !== undefined) {
          if (matchesSelector(current, selector)) return current
          current = current.parentNode
        }
        return null
      },
      querySelector(selector) {
        for (const child of this.children) {
          if (matchesSelector(child, selector)) return child
          const nested = child.querySelector(selector)
          if (nested !== null) return nested
        }
        return null
      },
      contains(other) {
        let current = other
        while (current !== null && current !== undefined) {
          if (current === this) return true
          current = current.parentNode
        }
        return false
      },
      getBoundingClientRect() {
        return this.rect !== undefined ? this.rect : { top: 120, left: 60, right: 260, bottom: 200, width: 200, height: 80 }
      },
      appendChild(child) {
        this.children.push(child)
        child.parentNode = this
        return child
      },
      remove() {
        if (this.parentNode) {
          const index = this.parentNode.children.indexOf(this)
          if (index !== -1) this.parentNode.children.splice(index, 1)
        }
        this.parentNode = null
      },
      focus() {
        this.focused = true
        documentMock.activeElement = this
      },
      blur() {
        this.focused = false
      },
      addEventListener() {},
      removeEventListener() {},
      setPointerCapture() {},
      offsetWidth: 200,
      offsetHeight: 80
    })

  const body = createNode('body', {})
  const head = createNode('head', {})
  const documentListeners = new Map()
  globalThis.document = {
    baseURI: 'http://127.0.0.1:65150/',
    head,
    body,
    activeElement: null,
    /** Set by the tests: (x, y) => node under the point. */
    hitTest: null,
    createElement: (tag) => createNode(tag, {}),
    elementFromPoint(x, y) {
      return typeof this.hitTest === 'function' ? this.hitTest(x, y) : null
    },
    addEventListener(type, handler) {
      documentListeners.set(type, handler)
    },
    removeEventListener(type) {
      documentListeners.delete(type)
    },
    querySelector: () => null,
    getElementById: () => null
  }
  const documentMock = globalThis.document
  const listeners = new Map()
  const intervals = new Set()
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    addEventListener(type, handler, options) {
      const capture = options === true || (options !== null && options !== undefined && options.capture === true)
      listeners.set(type + (capture ? ':capture' : ':bubble'), handler)
    },
    removeEventListener(type, handler, options) {
      const capture = options === true || (options !== null && options !== undefined && options.capture === true)
      listeners.delete(type + (capture ? ':capture' : ':bubble'))
    },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval(handler, ms) {
      const id = setInterval(handler, ms)
      intervals.add(id)
      return id
    },
    clearInterval(id) {
      intervals.delete(id)
      clearInterval(id)
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    open: () => null
  }
  const windowMock = globalThis.window
  const localStorageMock = {
    value: null,
    getItem() {
      return this.value
    },
    setItem(_key, value) {
      this.value = value
    }
  }
  globalThis.localStorage = localStorageMock
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} }, platform: 'Win32' },
    configurable: true,
    writable: true
  })
  globalThis.ClipboardItem = class ClipboardItem {}

  // Minimal React with per-session state slots: enough to execute the component
  // tree, re-render after an event handler changes state, and keep refs stable
  // within one overlay/peek session.
  const hooks = { current: [], component: null }
  const stateStore = new Map()
  let renderDirty = false
  let renderSession = null
  const slot = (create) => {
    const index = hooks.current.length
    hooks.current.push(create())
    return hooks.current[index]
  }
  const componentState = () => {
    const key = hooks.component
    let values = stateStore.get(key)
    if (values === undefined) {
      values = []
      stateStore.set(key, values)
    }
    return values
  }
  const ReactShim = {
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props)
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { $$el: true, type, props: merged }
    },
    Fragment: 'Fragment',
    useState(initial) {
      const values = componentState()
      const index = hooks.current.length
      if (values.length <= index) values[index] = typeof initial === 'function' ? initial() : initial
      hooks.current.push(values[index])
      const setter = (next) => {
        const previous = values[index]
        const value = typeof next === 'function' ? next(previous) : next
        if (Object.is(value, previous)) return
        values[index] = value
        renderDirty = true
      }
      return [values[index], setter]
    },
    useEffect() {},
    useLayoutEffect() {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef(value) {
      const values = componentState()
      const index = hooks.current.length
      if (values.length <= index) values[index] = { current: value }
      hooks.current.push(values[index])
      return values[index]
    },
    Component: class Component {
      constructor(props) {
        this.props = props
        this.state = {}
      }
      setState(next) {
        this.state = Object.assign({}, this.state, typeof next === 'function' ? next(this.state) : next)
      }
    }
  }
  ReactShim.Component.prototype.isReactComponent = {}

  /** Host elements whose handlers the checks may invoke. */
  const clickables = []
  const keyables = []
  const fakeNode = (type, props) => {
    const node = createNode(typeof type === 'string' ? type : 'div', {})
    for (const key of ['aria-label', 'title', 'role']) {
      if (props !== undefined && props !== null && typeof props[key] === 'string') node.setAttribute(key, props[key])
    }
    return node
  }

  const toMarkup = (node) => {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(toMarkup).join('')
    if (node.$$el !== true) return ''
    const props = node.props || {}
    if (typeof node.type === 'function') {
      if (node.type.prototype !== undefined && node.type.prototype.isReactComponent !== undefined) {
        const instance = new node.type(props)
        instance.props = props
        if (typeof node.type.getDerivedStateFromError === 'function' && instance.state.failed === undefined) instance.state.failed = false
        return toMarkup(instance.render())
      }
      const previous = hooks.current
      const previousComponent = hooks.component
      hooks.current = []
      hooks.component = node.type
      try {
        return toMarkup(node.type(props))
      } catch (error) {
        // Emulate the real error boundary: a component that throws must show up
        // in the markup instead of aborting the whole harness.
        const message = String(error !== null && error !== undefined && error.message ? error.message : error).replace(/"/g, "'")
        return '<div data-render-error="' + message + '">' + message + '</div>'
      } finally {
        hooks.current = previous
        hooks.component = previousComponent
      }
    }
    // The scoped stylesheet is not part of the rendered markup: keeping it out
    // makes every class-name assertion below prove a real element, not the CSS.
    if (node.type === 'style') return ''
    if (node.type === 'Fragment') return toMarkup(props.children)
    // One mock node per host element per pass: refs and recorded handlers share it.
    const domNode = fakeNode(node.type, props)
    if (typeof props.ref === 'function') {
      try {
        props.ref(domNode)
      } catch (_error) {
        /* a ref is not part of the markup */
      }
    } else if (props.ref !== null && props.ref !== undefined && typeof props.ref === 'object') {
      props.ref.current = domNode
    }
    if (typeof props.onClick === 'function') clickables.push({ type: node.type, props, node: domNode })
    if (typeof props.onKeyDown === 'function') keyables.push({ type: node.type, props, node: domNode })
    const attrs = []
    for (const key of Object.keys(props)) {
      if (key === 'children') continue
      const value = props[key]
      if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') attrs.push(key + '="' + String(value) + '"')
    }
    return '<' + node.type + ' ' + attrs.join(' ') + '>' + toMarkup(props.children) + '</' + node.type + '>'
  }
  const findRuntime = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findRuntime(child)
        if (found !== null) return found
      }
      return null
    }
    if (node.$$el !== true) return null
    if (node.props !== null && node.props !== undefined && node.props.runtime !== undefined) return node.props.runtime
    return findRuntime(node.props === undefined ? null : node.props.children)
  }

  // Host contract mock.
  const fetched = []
  const routes = {}
  const jsonResponse = (payload, status) => ({
    ok: (status || 200) < 400,
    status: status || 200,
    headers: { get: () => 'application/json; charset=utf-8' },
    json: async () => payload,
    blob: async () => new Blob([JSON.stringify(payload)])
  })
  const htmlResponse = () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/html' : null) },
    json: async () => {
      throw new Error('not json')
    },
    blob: async () => new Blob(['<html></html>'])
  })
  const pngResponse = () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'image/png' : null) },
    json: async () => {
      throw new Error('not json')
    },
    blob: async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' })
  })
  const imageMeta = () => ({
    ok: true,
    absPath: 'D:/ws/shot.png',
    name: 'shot.png',
    ext: 'png',
    size: 2048,
    mtimeMs: 1700000000000,
    preview: 'image',
    kind: 'image'
  })
  Object.assign(routes, {
    '/api/dsh-file-preview/status': () => jsonResponse({ ok: true, counters: {} }),
    '/api/dsh-file-preview/meta': () => jsonResponse(imageMeta()),
    '/api/dsh-file-preview/text': () => jsonResponse({ ok: true, text: 'line one\nline two', truncated: true, encoding: 'utf-8' }),
    '/api/dsh-file-preview/link': () =>
      jsonResponse({
        ok: true,
        url: 'https://example.com/x',
        host: 'example.com',
        title: 'Example title',
        description: 'Example description',
        siteName: 'Example',
        icon: '',
        image: ''
      }),
    '/api/dsh-file-preview/raw': () => pngResponse(),
    '/api/dsh-file-preview/action': () => jsonResponse({ ok: true }),
    '/api/dsh-file-preview/office-pdf': () => jsonResponse({ ok: false, code: 'office-unavailable' }, 501),
    '/api/dsh-file-preview/resolve': () => jsonResponse({ ok: true, absPath: 'D:/ws/notes.txt' })
  })
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url))
    fetched.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body })
    const handler = routes[parsed.pathname]
    if (handler === undefined) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => 'text/html' },
        json: async () => {
          throw new Error('not json')
        },
        blob: async () => new Blob([])
      }
    }
    return handler(parsed, init)
  }

  // Load the bundle exactly as the browser module table would.
  let factory = null
  globalThis.window = { __ModuleLoader__: { load: (registration) => { factory = registration.factory } } }
  runInThisContext(source, { filename: clientPath })
  assert('runtime-factory', 'the bundle registers its factory when executed', factory !== null)
  const plugin = factory((specifier) => {
    if (specifier === 'react') return ReactShim
    throw new Error('unexpected require: ' + specifier)
  })
  globalThis.window = windowMock
  assert('runtime-exports', 'the bundle returns a plugin with apply and inject', typeof plugin.apply === 'function' && Array.isArray(plugin.inject))

  // Mock client context.
  const dictionary = { en: {}, ru: {} }
  const registered = []
  const languages = []
  const effectDisposers = []
  let slotKey = null
  let registration = null
  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      effectDisposers.push({ label, dispose })
      return dispose
    },
    locale: {
      register(ns, locale, dict) {
        registered.push({ ns, locale, keys: Object.keys(dict).length })
        dictionary[locale] = dict
        return () => {}
      },
      addLanguage(language) {
        languages.push(language)
        return () => {}
      },
      bind() {
        return (key, params) => {
          const template = dictionary.ru[key] !== undefined ? dictionary.ru[key] : dictionary.en[key] !== undefined ? dictionary.en[key] : key
          if (params === undefined) return template
          return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
        }
      },
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'ru', locales: [{ id: 'en' }, { id: 'ru' }], revision: 4 })
    },
    slots: {
      inject(key, fn) {
        slotKey = key
        return fn()
      },
      register(options, component) {
        registration = { options, component }
        return () => {
          registration = null
        }
      }
    },
    sessions: {
      list: { getSnapshot: () => ({ ids: ['s1'], byId: { s1: { cwd: 'D:/ws' } }, phase: 'ready' }) },
      retainInfo: () => ({ getSnapshot: () => ({ retainedBy: { mainView: 1 } }) })
    },
    remote: { session: { openWorkspacePath: async () => ({ ok: true, value: true }) } },
    shortcuts: {}
  }

  plugin.apply(ctx)
  assert('runtime-dictionaries', 'apply registers both dictionaries', registered.length === 2 && registered.every((entry) => entry.ns === NS))
  assert('runtime-language-pack', 'an installed ru language pack stays in charge (no duplicate addLanguage)', languages.length === 0)
  assert(
    'runtime-slot',
    'apply registers the shell.overlay entry with a fresh id',
    slotKey === 'shell.overlay' && registration !== null && registration.options.name === 'shell.overlay' && registration.options.id === 'file-preview.overlay'
  )
  assert('runtime-entry-label', 'the entry label resolves through the dictionary', registration.options.label() === dictionary.ru['entry.label'])
  const expectedListeners = [
    'click:capture',
    'auxclick:capture',
    'pointerover:capture',
    'pointerout:capture',
    'pointermove:capture',
    'pointerdown:capture',
    'focusin:capture',
    'scroll:capture',
    'keydown:capture',
    'resize:capture',
    'blur:capture',
    'popstate:capture',
    'hashchange:capture'
  ]
  assert(
    'runtime-listeners',
    'every window listener is installed, including the pointer-move watchdog and window blur (negative control: dropping the pointermove/blur registration leaves the dismissal matrix dead)',
    expectedListeners.every((key) => listeners.has(key)),
    [...listeners.keys()].join(',')
  )
  assert(
    'runtime-document-listeners',
    'the document mouseleave listener is installed (negative control: without it leaving the document leaves the card behind)',
    documentListeners.has('mouseleave'),
    [...documentListeners.keys()].join(',')
  )
  assert(
    'runtime-seat',
    'boot announces seat=mounted',
    fetched.some((call) => call.url.includes('/api/dsh-file-preview/status?seat=mounted')),
    fetched.map((call) => call.url).join(' | ')
  )
  const cursorStyle = head.children.find((child) => child.getAttribute('data-dsh-file-preview-cursor') !== null)
  assert(
    'runtime-cursor',
    'the single scoped cursor rule is injected and removable',
    head.children.length === 1 &&
      cursorStyle !== undefined &&
      (cursorStyle.textContent.match(/\{/g) || []).length === 1 &&
      cursorStyle.textContent.includes('cursor: zoom-in'),
    cursorStyle === undefined ? 'missing' : cursorStyle.textContent
  )

  // Rendering driver: re-renders until the state is stable, so a click that
  // opens a menu (or closes one) is visible in the very next markup.
  let runtimeRef = null
  const renderTree = () => {
    const overlay = runtimeRef === null ? null : runtimeRef.overlay()
    const peek = runtimeRef === null ? null : runtimeRef.peek()
    const key = String(overlay === null ? 'none' : overlay.token) + ':' + String(peek === null ? 'none' : peek.nonce)
    if (key !== renderSession) {
      renderSession = key
      stateStore.clear()
    }
    let markup = ''
    let guard = 0
    do {
      renderDirty = false
      markup = toMarkup(tree())
    } while (renderDirty === true && (guard += 1) < 8)
    return markup
  }
  const tree = () => registration.component({})
  assert('runtime-root', 'the closed overlay renders only the plugin root', renderTree().includes('data-dsh-file-preview-root=""'))
  const runtime = findRuntime(tree())
  runtimeRef = runtime
  assert('runtime-handle', 'the runtime is reachable from the slot tree', runtime !== null)
  assert('runtime-translate', 'visible text resolves through the active locale', runtime.t('action.copyPath') === dictionary.ru['action.copyPath'])
  assert('runtime-cwd', 'the current session cwd is read', runtime.sessionCwd() === 'D:/ws', String(runtime.sessionCwd()))

  const clickEvent = (node, path) => {
    const event = {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      target: node,
      composedPath: () => path,
      prevented: false,
      stopped: false,
      preventDefault() {
        event.prevented = true
      },
      stopPropagation() {
        event.stopped = true
      }
    }
    return event
  }

  const image = createNode('img', { src: 'http://127.0.0.1:65150/api/file?path=D%3A%2Fws%2Fshot.png', alt: 'shot' }, body)
  const imageClick = clickEvent(image, [image, body])
  listeners.get('click:capture')(imageClick)
  assert('runtime-click-image', 'an api/file image click opens the overlay and stops the app handler', imageClick.prevented && imageClick.stopped && runtime.overlay() !== null)
  const openedMarkup = renderTree()
  assert(
    'runtime-modal-aria',
    'the modal renders as role=dialog with aria-modal and a labelled title',
    openedMarkup.includes('role="dialog"') && openedMarkup.includes('aria-modal="true"') && openedMarkup.includes('aria-labelledby="dsh-file-preview-title"')
  )
  assert('runtime-skeleton', 'the body starts with a loading skeleton', openedMarkup.includes('dfp-skeleton'))
  assert('runtime-header', 'the header shows the file name and path', openedMarkup.includes('shot.png') && openedMarkup.includes('D:/ws/shot.png'))
  assert('runtime-actions', 'the footer renders the four action buttons', openedMarkup.split('dfp-action').length - 1 >= 4)
  assert('runtime-mode-switch', 'the hover-mode switch is rendered and localized', openedMarkup.includes('aria-pressed="true"') && openedMarkup.includes(dictionary.ru['segment.peek']))
  const modifierClick = clickEvent(image, [image, body])
  modifierClick.metaKey = true
  listeners.get('click:capture')(modifierClick)
  assert('runtime-modifier', 'a modifier click is left to the application', modifierClick.prevented === false)

  const anchorWrap = createNode('div', {}, body)
  const anchor = createNode('a', { href: 'https://example.com/x' }, anchorWrap)
  const anchorClick = clickEvent(anchor, [anchor, anchorWrap, body])
  listeners.get('click:capture')(anchorClick)
  assert('runtime-web', 'an http(s) anchor opens the website card', anchorClick.prevented && runtime.overlay() !== null && runtime.overlay().kind === 'web')

  const presentedWrap = createNode('div', { 'data-presented-file': '' }, body)
  const presentedButton = createNode('button', { title: 'D:\\ws\\report.pdf' }, presentedWrap)
  presentedWrap.children.push(presentedButton)
  const presentedClick = clickEvent(presentedButton, [presentedButton, presentedWrap, body])
  listeners.get('click:capture')(presentedClick)
  assert(
    'runtime-presented',
    'a presented-file card opens with the absolute path from its title',
    presentedClick.prevented && runtime.overlay() !== null && runtime.overlay().path === 'D:\\ws\\report.pdf'
  )

  const attachmentRow = createNode('div', { 'data-message-attachments': '' }, body)
  const attachmentCard = createNode('span', { title: 'notes.txt' }, attachmentRow)
  attachmentRow.children.push(attachmentCard)
  const attachmentClick = clickEvent(attachmentCard, [attachmentCard, attachmentRow, body])
  listeners.get('click:capture')(attachmentClick)
  assert(
    'runtime-attachment',
    'a user attachment card opens by display name',
    attachmentClick.prevented && runtime.overlay() !== null && runtime.overlay().name === 'notes.txt'
  )

  const changed = createNode('div', { 'data-changed-files': '' }, body)
  const changedRow = createNode('button', { 'aria-describedby': 'p-0' }, changed)
  changed.children.push(changedRow)
  const changedClick = clickEvent(changedRow, [changedRow, changed, body])
  listeners.get('click:capture')(changedClick)
  assert('runtime-changed-files', 'the shipped changed-files diff rows are not taken over', changedClick.prevented === false)

  runtime.closePreview()
  const ownRoot = createNode('div', { 'data-dsh-file-preview-root': '' }, body)
  const ownClick = clickEvent(ownRoot, [ownRoot, body])
  listeners.get('click:capture')(ownClick)
  assert('runtime-own-root', 'clicks inside the plugin root are never intercepted', ownClick.prevented === false)

  const textMeta = (path, name, ext) => ({
    ok: true,
    absPath: path,
    name: name,
    ext: ext,
    size: 12,
    mtimeMs: 1700000000000,
    preview: 'text',
    kind: 'text'
  })
  routes['/api/dsh-file-preview/meta'] = (parsed) => {
    const requested = parsed.searchParams.get('path')
    if (requested === 'D:/ws/notes.txt') return jsonResponse(textMeta('D:/ws/notes.txt', 'notes.txt', 'txt'))
    if (requested === 'D:/ws/readme.md') return jsonResponse(Object.assign(textMeta('D:/ws/readme.md', 'readme.md', 'md'), { preview: 'markdown' }))
    if (requested === 'D:/ws/archive.zip') {
      return jsonResponse({
        ok: true,
        absPath: 'D:/ws/archive.zip',
        name: 'archive.zip',
        ext: 'zip',
        size: 4096,
        mtimeMs: 1700000000000,
        preview: 'none',
        kind: 'file'
      })
    }
    if (requested === 'D:/ws/raw.bin') {
      return jsonResponse({
        ok: true,
        absPath: 'D:/ws/raw.bin',
        name: 'raw.bin',
        ext: 'bin',
        size: 64,
        mtimeMs: 1700000000000,
        preview: 'none',
        kind: 'archive'
      })
    }
    if (requested === 'D:/ws/short.txt') return jsonResponse(textMeta('D:/ws/short.txt', 'short.txt', 'txt'))
    return jsonResponse(imageMeta())
  }
  routes['/api/dsh-file-preview/text'] = (parsed) => {
    const requested = parsed.searchParams.get('path')
    if (requested === 'D:/ws/readme.md') return jsonResponse({ ok: true, text: '# Title\n\nbody **bold**', truncated: false, encoding: 'utf-8' })
    if (requested === 'D:/ws/short.txt') return jsonResponse({ ok: true, text: 'alpha\nbeta', truncated: false, encoding: 'utf-8' })
    return jsonResponse({ ok: true, text: 'line one\nline two', truncated: true, encoding: 'utf-8' })
  }
  const signal = () => new AbortController().signal
  const meta = await runtime.resolveDescriptor({ kind: 'file', path: 'D:/ws/shot.png' }, signal())
  assert('runtime-meta', 'meta resolves to a ready state', meta.phase === 'ready' && meta.meta.name === 'shot.png' && meta.meta.preview === 'image')
  const cacheCalls = fetched.filter((call) => call.url.includes('/meta?')).length
  const cached = await runtime.resolveDescriptor({ kind: 'file', path: 'D:/ws/shot.png' }, signal())
  assert('runtime-meta-cache', 'meta is cached per path', cached.meta === meta.meta && fetched.filter((call) => call.url.includes('/meta?')).length === cacheCalls)

  const text = await runtime.fetchText('D:/ws/notes.txt', 4096, signal())
  assert('runtime-text', 'text resolves with truncation and encoding', text.phase === 'ready' && text.truncated === true && text.encoding === 'utf-8')
  const link = await runtime.fetchLink('https://example.com/x', signal())
  assert('runtime-link', 'link resolves with title and description', link.phase === 'ready' && link.link.title === 'Example title')
  const office = await runtime.officePdfUrl('D:/ws/doc.docx', signal())
  assert('runtime-office', 'an office 501 maps to the unavailable state', office.phase === 'unavailable')
  const imageUrl = await runtime.imageUrlFor('D:/ws/shot.png', signal())
  assert('runtime-blob', 'raw bytes become an object URL', imageUrl.phase === 'ready' && imageUrl.url.startsWith('blob:'))
  const attachment = await runtime.resolveDescriptor({ kind: 'attachment', name: 'notes.txt' }, signal())
  assert('runtime-resolve', 'an attachment resolves through /resolve', attachment.phase === 'ready' && attachment.meta.absPath === 'D:/ws/notes.txt')

  // Warm the caches, then render every viewer from them (no effects required).
  const textMaxBytes = Number(/const TEXT_MAX_BYTES = (\d+)/.exec(source)[1])
  await runtime.resolveDescriptor({ kind: 'file', path: 'D:/ws/notes.txt' }, signal())
  await runtime.fetchText('D:/ws/notes.txt', textMaxBytes, signal())
  await runtime.resolveDescriptor({ kind: 'file', path: 'D:/ws/readme.md' }, signal())
  await runtime.fetchText('D:/ws/readme.md', textMaxBytes, signal())
  await runtime.resolveDescriptor({ kind: 'file', path: 'D:/ws/archive.zip' }, signal())

  runtime.openPreview({ kind: 'file', path: 'D:/ws/shot.png' }, image)
  const imageMarkup = renderTree()
  assert(
    'runtime-view-image',
    'the image viewer renders a zoomable stage from the cached bytes',
    imageMarkup.includes('dfp-image-stage') && imageMarkup.includes('dfp-zoom-label') && imageMarkup.includes('src="blob:')
  )
  runtime.openPreview({ kind: 'file', path: 'D:/ws/notes.txt' }, null)
  const textMarkup = renderTree()
  assert(
    'runtime-view-text',
    'the text viewer renders numbered lines with a wrap toggle',
    textMarkup.includes('dfp-line') && textMarkup.includes('line one') && textMarkup.includes('dfp-tool')
  )
  runtime.openPreview({ kind: 'file', path: 'D:/ws/readme.md' }, null)
  const markdownMarkup = renderTree()
  assert(
    'runtime-view-markdown',
    'the markdown viewer renders blocks and a source toggle',
    markdownMarkup.includes('dfp-md') && markdownMarkup.includes('dfp-md-h') && markdownMarkup.includes(dictionary.ru['viewer.source'])
  )
  runtime.openPreview({ kind: 'file', path: 'D:/ws/archive.zip' }, null)
  const archiveMarkup = renderTree()
  assert('runtime-view-binary', 'an unknown file renders the metadata card with its extension badge', archiveMarkup.includes('dfp-filecard') && archiveMarkup.includes('ZIP'))
  assert(
    'runtime-view-kind-localized',
    'the metadata card renders the host kind as a localized label, never the raw enum',
    /dfp-filecard-meta">[^<]*Файл/.test(archiveMarkup) && /dfp-filecard-meta">[^<]*\bfile\b/.test(archiveMarkup) === false,
    archiveMarkup.slice(0, 400)
  )
  await runtime.resolveDescriptor({ kind: 'file', path: 'D:/ws/raw.bin' }, signal())
  runtime.openPreview({ kind: 'file', path: 'D:/ws/raw.bin' }, null)
  const rawKindMarkup = renderTree()
  assert(
    'runtime-view-kind-omitted',
    'an unknown host kind is omitted instead of being printed verbatim',
    rawKindMarkup.includes('dfp-filecard') && rawKindMarkup.includes('archive') === false && rawKindMarkup.includes('ARCHIVE') === false,
    rawKindMarkup.slice(0, 400)
  )
  runtime.openPreview({ kind: 'image-src', src: 'blob:https://127.0.0.1:65150/pasted-image', name: 'pasted.png' }, null)
  const srcImageMarkup = renderTree()
  assert(
    'runtime-view-image-src',
    'a blob/data/http image gets the same zoom/pan/fit stage as a file image',
    srcImageMarkup.includes('dfp-image-stage') &&
      srcImageMarkup.includes('dfp-zoom-label') &&
      srcImageMarkup.includes('src="blob:https://127.0.0.1:65150/pasted-image"') &&
      srcImageMarkup.includes(dictionary.ru['viewer.fit']) &&
      srcImageMarkup.includes(dictionary.ru['header.badgeImage']),
    srcImageMarkup.slice(0, 400)
  )
  runtime.openPreview({ kind: 'web', url: 'https://example.com/x' }, null)
  const webMarkup = renderTree()
  assert(
    'runtime-view-web',
    'the website card shows host, title, description and the open button',
    webMarkup.includes('example.com') && webMarkup.includes('Example title') && webMarkup.includes('Example description') && webMarkup.includes('dfp-link-btn')
  )
  assert('runtime-view-actions', 'the footer action labels are localized', webMarkup.includes(dictionary.ru['action.browser']))
  runtime.closePreview()

  routes['/api/dsh-file-preview/meta'] = (parsed) =>
    parsed.searchParams.get('path') === 'D:/ws/secret.bin'
      ? jsonResponse({
          ok: true,
          absPath: 'D:/ws/secret.bin',
          name: 'secret.bin',
          ext: 'bin',
          size: 9,
          mtimeMs: 1700000000000,
          preview: 'none',
          kind: 'file',
          canRead: false,
          reason: 'not-readable'
        })
      : jsonResponse(imageMeta())
  await runtime.resolveDescriptor({ kind: 'file', path: 'D:/ws/secret.bin' }, signal())
  runtime.openPreview({ kind: 'file', path: 'D:/ws/secret.bin' }, null)
  const deniedMarkup = renderTree()
  assert(
    'runtime-view-denied',
    'an unreadable file renders the metadata card plus a permission state',
    deniedMarkup.includes('dfp-filecard') && deniedMarkup.includes(dictionary.ru['state.deniedBody'])
  )

  routes['/api/dsh-file-preview/link'] = () => jsonResponse({ ok: true, url: 'https://example.com/y', host: 'example.com', error: 'timeout' })
  await runtime.fetchLink('https://example.com/y', signal())
  runtime.openPreview({ kind: 'web', url: 'https://example.com/y' }, null)
  const partialMarkup = renderTree()
  assert(
    'runtime-view-link-partial',
    'a partial link read still renders an openable card with a notice',
    partialMarkup.includes(dictionary.ru['web.unavailable']) && partialMarkup.includes('dfp-link-btn')
  )
  runtime.closePreview()

  routes['/api/dsh-file-preview/meta'] = () => htmlResponse()
  const missing = await runtime.resolveDescriptor({ kind: 'file', path: 'D:/ws/other.png' }, signal())
  assert('runtime-restart', 'a non-plugin host answer maps to the restart hint', missing.phase === 'hostMissing')

  let clipboardText = null
  globalThis.navigator.clipboard.writeText = async (value) => {
    clipboardText = value
  }
  const copy = await runtime.perform('copy-path', { path: 'D:/ws/shot.png', displayPath: 'D:/ws/shot.png' })
  assert('runtime-copy', 'copy-path writes the path to the clipboard', copy.ok && copy.toast === 'toast.copiedPath' && clipboardText === 'D:/ws/shot.png')

  let posted = null
  routes['/api/dsh-file-preview/action'] = (parsed, init) => {
    posted = JSON.parse(init.body)
    return jsonResponse({ ok: true })
  }
  const reveal = await runtime.perform('reveal', { path: 'D:/ws/shot.png' })
  assert('runtime-reveal', 'reveal posts to /action and reports success', reveal.ok && reveal.toast === 'toast.revealed' && posted.action === 'reveal')

  let remoteCalls = 0
  ctx.remote.session.openWorkspacePath = async () => {
    remoteCalls += 1
    return { ok: true, value: true }
  }
  routes['/api/dsh-file-preview/action'] = () => jsonResponse({ ok: false, code: 'action-unavailable' }, 503)
  const fallback = await runtime.perform('open', { path: 'D:/ws/shot.png' })
  assert('runtime-remote-fallback', 'open falls back to remote.session.openWorkspacePath', fallback.ok && remoteCalls === 1)

  //#region Markdown preview, end to end with real content
  const readmeText = readFileSync(root + '/README.md', 'utf8')
  const crlfNote =
    '# Заметка\r\n\r\nСтрока с **жирным**, `кодом` и [ссылкой](https://example.com/doc).\r\n\r\n```js\r\nconst x = 1\r\n```\r\n\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n'
  const markdownMeta = (path, name) => ({
    ok: true,
    absPath: path,
    name: name,
    ext: 'md',
    size: 1024,
    mtimeMs: 1700000000000,
    preview: 'markdown',
    kind: 'file'
  })
  routes['/api/dsh-file-preview/meta'] = (parsed) => {
    const requested = parsed.searchParams.get('path')
    if (requested === 'D:/plugin/README.md') return jsonResponse(markdownMeta('D:/plugin/README.md', 'README.md'))
    if (requested === 'D:/ws/note-crlf.md') return jsonResponse(markdownMeta('D:/ws/note-crlf.md', 'note-crlf.md'))
    if (requested === 'D:/ws/empty.md') return jsonResponse(markdownMeta('D:/ws/empty.md', 'empty.md'))
    return jsonResponse(imageMeta())
  }
  routes['/api/dsh-file-preview/text'] = (parsed) => {
    const requested = parsed.searchParams.get('path')
    if (requested === 'D:/plugin/README.md') return jsonResponse({ ok: true, text: readmeText, truncated: false, encoding: 'utf-8' })
    if (requested === 'D:/ws/note-crlf.md') return jsonResponse({ ok: true, text: crlfNote, truncated: false, encoding: 'utf-8' })
    if (requested === 'D:/ws/empty.md') return jsonResponse({ ok: true, text: '', truncated: false, encoding: 'utf-8' })
    return jsonResponse({ ok: true, text: 'line one\nline two', truncated: true, encoding: 'utf-8' })
  }
  const markdownTextMax = Number(/const TEXT_MAX_BYTES = (\d+)/.exec(source)[1])
  for (const markdownPath of ['D:/plugin/README.md', 'D:/ws/note-crlf.md', 'D:/ws/empty.md']) {
    await runtime.resolveDescriptor({ kind: 'file', path: markdownPath }, signal())
    await runtime.fetchText(markdownPath, markdownTextMax, signal())
  }

  assert('runtime-markdown-fixture', 'the markdown fixture is the plugin README (>= 10 KB); a missing or shrunken README fails here instead of silently weakening the fixture', readmeText.length >= 10240, String(readmeText.length))
  runtime.openPreview({ kind: 'file', path: 'D:/plugin/README.md' }, null)
  const readmeMarkup = renderTree()
  assert(
    'runtime-markdown-readme',
    'the plugin README renders end to end with headings, fenced code, inline code and paragraphs (negative control: a throwing construct would surface the error boundary instead)',
    readmeMarkup.includes('dfp-md') &&
      readmeMarkup.includes('dfp-md-h') &&
      readmeMarkup.includes('dfp-md-code') &&
      readmeMarkup.includes('dfp-md-inline-code') &&
      readmeMarkup.includes('dfp-md-p')
  )
  assert(
    'runtime-markdown-no-boundary',
    'no markdown construct reaches the overlay error boundary or the error card (negative control: a throwing construct renders data-render-error / the boundary title here)',
    readmeMarkup.includes('data-failed="true"') === false &&
      readmeMarkup.includes('data-render-error') === false &&
      readmeMarkup.includes(dictionary.ru['error.boundaryTitle']) === false &&
      readmeMarkup.includes(dictionary.ru['state.errorTitle']) === false
  )
  runtime.openPreview({ kind: 'file', path: 'D:/ws/note-crlf.md' }, null)
  const crlfMarkup = renderTree()
  assert(
    'runtime-markdown-crlf',
    'a CRLF note with Cyrillic keeps its headings, fences and link (negative control: without CRLF normalization the heading line is not recognized)',
    crlfMarkup.includes('dfp-md-h') &&
      crlfMarkup.includes('dfp-md-code') &&
      crlfMarkup.includes('dfp-md-link') &&
      crlfMarkup.includes('Заметка') &&
      crlfMarkup.includes('жирным')
  )
  runtime.openPreview({ kind: 'file', path: 'D:/ws/empty.md' }, null)
  const emptyMarkup = renderTree()
  assert(
    'runtime-markdown-empty',
    'an empty markdown file renders the empty state, not an error (negative control: treating it as a failure shows the error card)',
    emptyMarkup.includes('dfp-empty') && emptyMarkup.includes(dictionary.ru['viewer.empty']) && emptyMarkup.includes(dictionary.ru['state.errorTitle']) === false
  )
  runtime.closePreview()
  //#endregion

  //#region Diagnosable failure states
  const longMissingPath = 'D:/ws/very/long/folder/name/that/keeps/going/and/going/and/going/README.md'
  routes['/api/dsh-file-preview/meta'] = (parsed) => {
    const requested = parsed.searchParams.get('path')
    if (requested === longMissingPath) return jsonResponse({ ok: false, code: 'not-found' }, 404)
    if (requested === 'D:/ws/denied.md') return jsonResponse({ ok: false, code: 'denied' }, 403)
    if (requested === 'D:/outside/README.md') return jsonResponse({ ok: false, code: 'outside-allowed-roots' }, 403)
    return jsonResponse(imageMeta())
  }
  await runtime.resolveDescriptor({ kind: 'file', path: longMissingPath }, signal())
  await runtime.resolveDescriptor({ kind: 'file', path: 'D:/ws/denied.md' }, signal())
  await runtime.resolveDescriptor({ kind: 'file', path: 'D:/outside/README.md' }, signal())
  /** The "requested path" line of a state card (scoped, so the header cannot satisfy it). */
  const pathLineOf = (markup) => {
    const marker = dictionary.ru['state.requestedPath'].replace('{path}', '')
    const index = markup.indexOf(marker)
    return index === -1 ? '' : markup.slice(index, index + 260)
  }

  runtime.openPreview({ kind: 'file', path: longMissingPath }, null)
  const notFoundMarkup = renderTree()
  assert(
    'runtime-error-code',
    'a failed preview names its failure code and asks for it in a report (negative control: the old generic card had neither)',
    notFoundMarkup.includes(dictionary.ru['state.notFoundTitle']) &&
      notFoundMarkup.includes(dictionary.ru['state.code'].replace('{code}', 'not-found')) &&
      notFoundMarkup.includes(dictionary.ru['state.codeHint'])
  )
  const notFoundPathLine = pathLineOf(notFoundMarkup)
  assert(
    'runtime-error-path',
    'the state card shows the requested path middle-truncated and localized (negative control: without the path line this is empty)',
    notFoundPathLine.includes('D:/ws/very') &&
      notFoundPathLine.includes('…') &&
      notFoundPathLine.includes('README.md') &&
      notFoundPathLine.includes(longMissingPath) === false,
    notFoundPathLine
  )
  runtime.openPreview({ kind: 'file', path: 'D:/ws/denied.md' }, null)
  const deniedPathMarkup = renderTree()
  const deniedPathLine = pathLineOf(deniedPathMarkup)
  assert(
    'runtime-error-denied',
    'a denied path names the denial title, the code and the requested path in the card (negative control: the old generic card carried neither)',
    deniedPathMarkup.includes(dictionary.ru['state.deniedTitle']) && deniedPathMarkup.includes('denied') && deniedPathLine.includes('D:/ws/denied.md'),
    deniedPathLine
  )
  runtime.openPreview({ kind: 'file', path: 'D:/outside/README.md' }, null)
  const outsideMarkup = renderTree()
  const outsidePathLine = pathLineOf(outsideMarkup)
  assert(
    'runtime-error-outside-roots',
    'outside-allowed-roots explains the readable area, names readScope and shows the path in the card (negative control: without the hint the readScope mention is absent)',
    outsideMarkup.includes(dictionary.ru['state.outsideRootsTitle']) &&
      outsideMarkup.includes(dictionary.ru['state.outsideRootsBody']) &&
      outsideMarkup.includes('outside-allowed-roots') &&
      outsideMarkup.includes('readScope') &&
      outsidePathLine.includes('D:/outside/README.md'),
    outsidePathLine
  )
  runtime.closePreview()
  //#endregion

  //#region Copy split control and the modal close button
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const buttonByAria = (aria) => clickables.find((entry) => entry.props['aria-label'] === aria)
  const menuItems = () => clickables.filter((entry) => entry.props.role === 'menuitem')
  const menuEntry = () => keyables.find((entry) => entry.props.role === 'menu')
  const startsWith = (value, prefix) => typeof value === 'string' && value.indexOf(prefix) === 0

  // Warm the text caches the copy choices read (the peek budget and the copy budget).
  const copyTextMax = Number(/const TEXT_MAX_BYTES = (\d+)/.exec(source)[1])
  await runtime.resolveDescriptor({ kind: 'file', path: 'D:/ws/notes.txt' }, signal())
  await runtime.fetchText('D:/ws/notes.txt', 4096, signal())
  await runtime.fetchText('D:/ws/notes.txt', copyTextMax, signal())

  runtime.openPreview({ kind: 'file', path: 'D:/ws/notes.txt' }, null)
  clickables.length = 0
  keyables.length = 0
  const modalMarkup = renderTree()
  const copyToggle = buttonByAria(dictionary.ru['copy.toggle'])
  assert(
    'runtime-copy-split',
    'the modal copy control is a split button: primary button plus a menu toggle (negative control: a plain button has no toggle)',
    copyToggle !== undefined && modalMarkup.includes('aria-haspopup="menu"') && modalMarkup.includes('dfp-split')
  )
  assert(
    'runtime-modal-close-button',
    'the full-preview header carries a localized close button (negative control: without it the lookup fails)',
    buttonByAria(dictionary.ru['dialog.close']) !== undefined
  )
  clickables.length = 0
  copyToggle.props.onClick()
  const openMenuMarkup = renderTree()
  const items = menuItems()
  assert(
    'runtime-copy-menu-items',
    'the menu lists exactly the three copy choices in the active locale, path / contents / file (negative control: a merged or mislabelled menu fails the count)',
    items.length === 3 &&
      items.every((entry) => entry.props.role === 'menuitem') &&
      startsWith(items[0] === undefined ? '' : items[0].props['aria-label'], dictionary.ru['copy.path']) &&
      startsWith(items[1] === undefined ? '' : items[1].props['aria-label'], dictionary.ru['copy.contents']) &&
      startsWith(items[2] === undefined ? '' : items[2].props['aria-label'], dictionary.ru['copy.file']) &&
      openMenuMarkup.includes('role="menu"'),
    String(items.length)
  )
  const menu = menuEntry()
  assert(
    'runtime-copy-menu-keyboard',
    'the menu container handles keys (negative control: without onKeyDown Escape would close the modal instead of the menu)',
    menu !== undefined
  )
  menu.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
  const afterEscapeMarkup = renderTree()
  assert(
    'runtime-copy-menu-escape',
    'Escape closes the menu (not the modal) and returns focus to the toggle',
    afterEscapeMarkup.includes('role="menu"') === false &&
      documentMock.activeElement !== null &&
      documentMock.activeElement !== undefined &&
      documentMock.activeElement.getAttribute('aria-label') === dictionary.ru['copy.toggle'],
    String(documentMock.activeElement === null ? 'null' : 'node')
  )

  const openCopyMenu = () => {
    clickables.length = 0
    keyables.length = 0
    renderTree()
    const toggle = buttonByAria(dictionary.ru['copy.toggle'])
    if (toggle === undefined) return false
    toggle.props.onClick()
    renderTree()
    return true
  }

  assert('runtime-copy-menu-reopen', 'the menu can be reopened after Escape (setup: without it the following choice assertions cannot run)', openCopyMenu() === true)
  const pathItem = menuItems().find((entry) => startsWith(entry.props['aria-label'], dictionary.ru['copy.path']))
  clipboardText = null
  if (pathItem !== undefined) pathItem.props.onClick()
  await sleep(40)
  renderTree()
  assert(
    'runtime-copy-menu-path',
    'the path choice copies the absolute path (negative control: a wrong target copies nothing)',
    clipboardText === 'D:/ws/notes.txt',
    String(clipboardText)
  )

  assert('runtime-copy-menu-reopen-contents', 'the menu reopens for the contents choice (setup guard)', openCopyMenu() === true)
  const contentsItem = menuItems().find((entry) => startsWith(entry.props['aria-label'], dictionary.ru['copy.contents']))
  clipboardText = null
  if (contentsItem !== undefined) contentsItem.props.onClick()
  await sleep(30)
  renderTree()
  assert(
    'runtime-copy-menu-contents',
    'the contents choice copies the text for a text file',
    clipboardText === 'line one\nline two',
    String(clipboardText)
  )

  let copyFilePosted = null
  let actionCalls = 0
  routes['/api/dsh-file-preview/action'] = (parsed, init) => {
    actionCalls += 1
    copyFilePosted = JSON.parse(init.body)
    return jsonResponse({ ok: true })
  }
  assert('runtime-copy-menu-reopen-file', 'the menu reopens for the file choice (setup guard)', openCopyMenu() === true)
  actionCalls = 0
  const fileItem = menuItems().find((entry) => startsWith(entry.props['aria-label'], dictionary.ru['copy.file']))
  if (fileItem !== undefined) fileItem.props.onClick()
  await sleep(60)
  const fileToastMarkup = renderTree()
  assert(
    'runtime-copy-menu-file',
    'the file choice posts {action:copy-file, path} to the host once and toasts success',
    copyFilePosted !== null &&
      copyFilePosted.action === 'copy-file' &&
      copyFilePosted.path === 'D:/ws/notes.txt' &&
      actionCalls === 1 &&
      fileToastMarkup.includes(dictionary.ru['toast.copiedFile']),
    JSON.stringify({ posted: copyFilePosted, actionCalls })
  )

  routes['/api/dsh-file-preview/action'] = () => {
    actionCalls += 1
    return jsonResponse({ ok: false, code: 'action-unavailable' }, 501)
  }
  assert('runtime-copy-menu-reopen-unavailable', 'the menu reopens when the host cannot copy the file (setup guard)', openCopyMenu() === true)
  actionCalls = 0
  const fileItem2 = menuItems().find((entry) => startsWith(entry.props['aria-label'], dictionary.ru['copy.file']))
  if (fileItem2 !== undefined) fileItem2.props.onClick()
  await sleep(60)
  const unavailableMarkup = renderTree()
  assert(
    'runtime-copy-menu-file-unavailable',
    'an action-unavailable host answer shows the localized explanation, not a raw error, and is not retried (negative control: a retry would post twice)',
    unavailableMarkup.includes(dictionary.ru['copy.fileUnavailable']) &&
      unavailableMarkup.includes(dictionary.ru['toast.copiedFile']) === false &&
      actionCalls === 1,
    String(actionCalls)
  )

  // Cold start: the first file copy may exceed the host launcher budget once.
  // A `copy-file-failed` whose message mentions a timeout is retried exactly once.
  let coldCalls = 0
  routes['/api/dsh-file-preview/action'] = () => {
    coldCalls += 1
    if (coldCalls === 1) return jsonResponse({ ok: false, code: 'copy-file-failed', message: 'launcher timed out after 3000 ms' }, 500)
    return jsonResponse({ ok: true })
  }
  assert('runtime-copy-file-cold-reopen', 'the menu reopens for the cold-start retry case (setup guard)', openCopyMenu() === true)
  coldCalls = 0
  const coldItem = menuItems().find((entry) => startsWith(entry.props['aria-label'], dictionary.ru['copy.file']))
  if (coldItem !== undefined) coldItem.props.onClick()
  await sleep(320)
  const coldMarkup = renderTree()
  assert(
    'runtime-copy-file-cold-retry',
    'a cold-start timeout is retried exactly once and then succeeds, with no error toast (negative control: without the retry only one POST happens and copy.fileFailed appears)',
    coldCalls === 2 &&
      coldMarkup.includes(dictionary.ru['toast.copiedFile']) &&
      coldMarkup.includes(dictionary.ru['copy.fileFailed']) === false,
    JSON.stringify({ coldCalls })
  )

  let coldFailCalls = 0
  routes['/api/dsh-file-preview/action'] = () => {
    coldFailCalls += 1
    return jsonResponse({ ok: false, code: 'copy-file-failed', message: 'The copy timed out' }, 500)
  }
  assert('runtime-copy-file-cold-fail-reopen', 'the menu reopens for the second cold-start failure (setup guard)', openCopyMenu() === true)
  coldFailCalls = 0
  const coldFailItem = menuItems().find((entry) => startsWith(entry.props['aria-label'], dictionary.ru['copy.file']))
  if (coldFailItem !== undefined) coldFailItem.props.onClick()
  await sleep(320)
  const coldFailMarkup = renderTree()
  assert(
    'runtime-copy-file-cold-fails',
    'a second cold-start timeout surfaces the localized error after exactly one retry (negative control: no retry means one POST and the same toast)',
    coldFailCalls === 2 && coldFailMarkup.includes(dictionary.ru['copy.fileFailed']),
    JSON.stringify({ coldFailCalls })
  )

  routes['/api/dsh-file-preview/action'] = () => jsonResponse({ ok: true })

  runtime.openPreview({ kind: 'file', path: 'D:/ws/archive.zip' }, null)
  clickables.length = 0
  keyables.length = 0
  renderTree()
  const zipToggle = buttonByAria(dictionary.ru['copy.toggle'])
  if (zipToggle !== undefined) zipToggle.props.onClick()
  const zipMenuMarkup = renderTree()
  const zipContents = menuItems().find((entry) => startsWith(entry.props['aria-label'], dictionary.ru['copy.contents']))
  assert(
    'runtime-copy-menu-contents-disabled',
    'contents is disabled with a localized reason for a binary file (negative control: a binary file has no copyable contents)',
    zipContents !== undefined && zipContents.props.disabled === true && zipMenuMarkup.includes(dictionary.ru['copy.contentsUnavailable'])
  )

  runtime.openPreview({ kind: 'file', path: 'D:/ws/notes.txt' }, null)
  clickables.length = 0
  renderTree()
  const modalClose = buttonByAria(dictionary.ru['dialog.close'])
  assert('runtime-modal-close-button-click', 'the modal close button is a real button (negative control: without it this lookup fails)', modalClose !== undefined)
  if (modalClose !== undefined) modalClose.props.onClick()
  await sleep(220)
  assert('runtime-modal-close', 'clicking the modal close button closes the overlay (negative control: without the timer the overlay stays open)', runtime.overlay() === null)
  await sleep(420)
  //#endregion

  //#region Hover: target grace, geometry watchdog, target poll, cooldown, card features
  routes['/api/dsh-file-preview/meta'] = () => jsonResponse(imageMeta())
  runtime.setHoverMode('peek')
  const defaultHitTest = (x, y) => {
    const inside = x >= 60 && x <= 260 && y >= 120 && y <= 200
    return inside ? (runtime.getPopover() || image) : body
  }
  document.hitTest = defaultHitTest
  const pointerMove = (x, y, target) => {
    const node = target === undefined ? body : target
    listeners.get('pointermove:capture')({
      pointerType: 'mouse',
      clientX: x,
      clientY: y,
      target: node,
      composedPath: () => [node],
      preventDefault() {},
      stopPropagation() {}
    })
  }
  const pointerDown = (target) => {
    const node = target === undefined ? body : target
    listeners.get('pointerdown:capture')({ button: 0, target: node, composedPath: () => [node], preventDefault() {}, stopPropagation() {} })
  }
  const waitCooldown = async () => {
    while (runtime.hoverState().suppressForMs > 0) await sleep(40)
  }
  const openPeekFor = async (element) => {
    await waitCooldown()
    pointerMove(120, 150, element)
    runtime.schedulePeek(element)
    // Both hover delays (350 ms peek / 450 ms full) are covered.
    await sleep(520)
  }
  const openPeekAndWait = () => openPeekFor(image)

  await openPeekAndWait()
  assert('runtime-peek', 'hover opens exactly one peek card after the delay', runtime.peek() !== null && runtime.peek().mode === 'peek' && runtime.peek().closing === false)
  clickables.length = 0
  const peekMarkup = renderTree()
  assert('runtime-peek-render', 'the peek card renders its header and quick actions', peekMarkup.includes('dfp-peek') && peekMarkup.includes('shot.png'))
  const cardNode = runtime.getPopover()
  assert('runtime-peek-popover', 'the card registers itself as the hover popover', cardNode !== null)

  // Owner-requested card affordances: close X, copy split, no dead full-preview line.
  const peekClose = buttonByAria(dictionary.ru['peek.close'])
  assert(
    'runtime-peek-close-x',
    'the card has a visible close button (X icon, real button, localized aria-label) in its own header',
    peekClose !== undefined && peekMarkup.includes('dfp-peek-close') && peekMarkup.includes(dictionary.ru['peek.close'])
  )
  assert(
    'runtime-peek-copy-split',
    'the card copy control is the same split button (menu toggle with a localized label)',
    buttonByAria(dictionary.ru['copy.toggle']) !== undefined
  )
  assert(
    'runtime-peek-no-dead-more',
    'a complete image peek renders no full-preview line (negative control: a dead line would appear here)',
    peekMarkup.includes('dfp-peek-more') === false
  )

  // A press inside the card must not dismiss it: its quick actions have to stay
  // clickable (a closing card is pointer-events:none and eats the click).
  pointerDown(cardNode)
  assert(
    'runtime-peek-pointerdown-inside',
    'a pointerdown inside the card never dismisses it',
    runtime.peek() !== null && runtime.peek().closing === false,
    JSON.stringify(runtime.peek())
  )
  const quickOpen = clickables.find((entry) => entry.props.title === dictionary.ru['hover.open'])
  assert('runtime-peek-quick-actions', 'the card exposes its quick actions', clickables.filter((entry) => entry.type === 'button').length >= 3)
  if (quickOpen !== undefined) quickOpen.props.onClick()
  assert(
    'runtime-peek-quick-action-runs',
    'a quick action runs after an inside pointerdown (negative control: a closure bug leaves it a no-op and the overlay stays null)',
    runtime.overlay() !== null && runtime.overlay().path === 'D:/ws/shot.png',
    String(runtime.overlay() === null ? 'null' : runtime.overlay().path)
  )
  runtime.closePreview()

  // The close X dismisses the card.
  await openPeekAndWait()
  clickables.length = 0
  renderTree()
  const closeX = buttonByAria(dictionary.ru['peek.close'])
  assert('runtime-peek-close-x-click', 'the close X is clickable (negative control: without the button it cannot be found)', closeX !== undefined)
  if (closeX !== undefined) closeX.props.onClick()
  assert(
    'runtime-peek-close-x-dismisses',
    'the close X dismisses immediately (the card starts closing on the click)',
    runtime.peek() !== null && runtime.peek().closing === true
  )
  await sleep(200)
  assert('runtime-peek-close-x-gone', 'the closed card is removed (negative control: a leaked finalizer would leave it in the store)', runtime.peek() === null)

  // (a) A pointermove over anything unrelated to the anchor and the card arms the
  // short close grace: the reported live shape, with no pointerout/relatedTarget.
  await openPeekAndWait()
  pointerMove(900, 700, body)
  assert(
    'runtime-peek-target-grace',
    'a pointermove onto an unrelated element arms the short close grace, with no pointerout needed (negative control: without the target check the grace stays idle and the card survives)',
    runtime.hoverState().graceArmed === true && runtime.peek() !== null && runtime.peek().closing === false
  )
  await sleep(150)
  assert('runtime-peek-target-closes', 'the card is closing shortly after the grace expires', runtime.peek() !== null && runtime.peek().closing === true)
  await sleep(160)
  assert('runtime-peek-target-gone', 'the card is gone (negative control: without the target grace it stays on screen)', runtime.peek() === null)

  // (b) Second net: geometry only (the target is still the anchor, the point is off it).
  await openPeekAndWait()
  pointerMove(900, 700, image)
  assert(
    'runtime-peek-watchdog-armed',
    'a pointermove outside both rects arms the ~200 ms watchdog while the target is still related (negative control: without it nothing closes the card)',
    runtime.hoverState().watchdogArmed === true && runtime.hoverState().watchdogMs === 200 && runtime.hoverState().graceArmed === false && runtime.peek() !== null && runtime.peek().closing === false
  )
  await sleep(230)
  assert(
    'runtime-peek-watchdog-fires',
    'the geometry watchdog closes the card ~200 ms after the pointer left, with no further events (negative control: without it the card stays open forever)',
    runtime.peek() !== null && runtime.peek().closing === true
  )
  await sleep(140)
  assert('runtime-peek-watchdog-gone', 'the card is fully removed after the fade', runtime.peek() === null)

  // (c) Poll path: the pointer stops moving and the chat re-renders the anchor
  // away, so nothing under the last point is related any more.
  await openPeekAndWait()
  const pollCard = runtime.getPopover()
  const imageRect = image.rect
  image.rect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
  if (pollCard !== null && pollCard !== undefined) pollCard.rect = { top: 500, left: 500, right: 700, bottom: 600, width: 200, height: 100 }
  document.hitTest = () => body
  // Wait for the first unrelated tick instead of assuming wall-clock timing.
  const pollStartedAt = Date.now()
  while (runtime.hoverState().pollMisses === 0 && runtime.peek() !== null && Date.now() - pollStartedAt < 600) await sleep(20)
  assert(
    'runtime-peek-poll-first-tick',
    'a single unrelated poll tick leaves the card open (two-tick rule; negative control: a one-tick rule would close a card the user still hovers)',
    runtime.peek() !== null && runtime.peek().closing === false && runtime.hoverState().pollMisses === 1,
    JSON.stringify(runtime.hoverState())
  )
  // Then wait for the poll itself to dismiss it, with no pointer event at all.
  while (runtime.peek() !== null && Date.now() - pollStartedAt < 1200) await sleep(20)
  assert(
    'runtime-peek-poll-closes',
    'a stationary pointer over an unrelated element closes the card after the second tick, with no pointer event (negative control: without the poll it never closes here)',
    runtime.peek() === null && runtime.debug().lastSource === 'poll',
    JSON.stringify(runtime.debug())
  )
  assert('runtime-peek-poll-gone', 'the polled card is removed (negative control: a stuck closing state would keep it)', runtime.peek() === null)
  image.rect = imageRect
  document.hitTest = defaultHitTest

  // Moving over the card keeps it open and interactive.
  await openPeekAndWait()
  const cardAgain = runtime.getPopover()
  pointerMove(120, 150, cardAgain)
  assert(
    'runtime-peek-inside-keeps',
    'a pointer over the card cancels the watchdog and keeps it open (negative control: an always-armed watchdog would close a hovered card)',
    runtime.hoverState().watchdogArmed === false && runtime.peek() !== null && runtime.peek().closing === false
  )
  clickables.length = 0
  renderTree()
  const quickAgain = clickables.find((entry) => entry.props.title === dictionary.ru['hover.open'])
  assert('runtime-peek-actions-after-move', 'quick actions stay clickable after moving into the card (negative control: a dismissed card has no buttons left)', quickAgain !== undefined)
  if (quickAgain !== undefined) quickAgain.props.onClick()
  runtime.closePreview()
  await sleep(160)

  // Cooldown: the pointerover the browser fires when the card unmounts must not
  // reopen it. This is the live "card never disappears" symptom.
  await openPeekAndWait()
  listeners.get('keydown:capture')({ key: 'Escape' })
  assert('runtime-peek-escape', 'Escape dismisses the card (negative control: without the Escape branch it stays on screen)', runtime.peek() !== null && runtime.peek().closing === true)
  runtime.schedulePeek(image)
  assert(
    'runtime-peek-cooldown',
    'a dismissal suppresses new hover targets for ~400 ms, so the unmount pointerover cannot reopen the card (negative control: without the cooldown the open timer is armed and the card returns)',
    runtime.peek() !== null && runtime.peek().closing === true && runtime.hoverState().openTimerArmed === false && runtime.hoverState().suppressForMs > 0,
    JSON.stringify(runtime.hoverState())
  )
  await sleep(460)
  assert('runtime-peek-cooldown-null', 'the store still ends at null while reopen attempts are suppressed', runtime.peek() === null)
  await openPeekAndWait()
  assert(
    'runtime-peek-cooldown-expires',
    'after the cooldown a new hover opens again (negative control: a permanent block would never reopen)',
    runtime.peek() !== null && runtime.peek().closing === false
  )
  runtime.dismissPeek('test-cleanup')
  await sleep(460)

  // Idempotent dismissal: repeated calls must not cancel the final null.
  await openPeekAndWait()
  runtime.dismissPeek('multi-1')
  runtime.dismissPeek('multi-2')
  runtime.dismissPeek('multi-3')
  assert(
    'runtime-peek-dismiss-idempotent',
    'repeated dismissals keep a finalizer scheduled (negative control: the old ordering cancelled the pending null and the card stayed in the store)',
    runtime.peek() !== null && runtime.peek().closing === true && runtime.hoverState().fadePending === true
  )
  await sleep(430)
  assert('runtime-peek-dismiss-null', 'the store is null after repeated dismissals', runtime.peek() === null)

  // Dismissal matrix: every documented trigger closes the card.
  const closingAfter = async (trigger, label, id) => {
    await openPeekAndWait()
    trigger()
    assert(id, label, runtime.peek() !== null && runtime.peek().closing === true, JSON.stringify(runtime.peek()))
    await sleep(160)
  }
  await closingAfter(() => pointerDown(), 'an outside pointerdown still dismisses the card (negative control: without the outside branch it never closes)', 'runtime-peek-pointerdown-outside')
  await closingAfter(() => listeners.get('blur:capture')({}), 'window blur dismisses the card (negative control: without the blur listener the card survives a window switch)', 'runtime-peek-blur')
  await closingAfter(() => documentListeners.get('mouseleave')({ relatedTarget: null }), 'leaving the document dismisses the card (negative control: without the document mouseleave listener it survives leaving the window)', 'runtime-peek-document-leave')
  await closingAfter(() => listeners.get('scroll:capture')({ target: body, composedPath: () => [body] }), 'chat scroll dismisses the card (negative control: without the scroll branch it stays on screen)', 'runtime-peek-scroll')
  await closingAfter(() => listeners.get('wheel:capture')({ target: body, composedPath: () => [body] }), 'wheel outside the card dismisses it (negative control: without the wheel branch it stays on screen)', 'runtime-peek-wheel')
  await closingAfter(() => runtime.setHoverMode('off'), 'switching the mode to off dismisses the card (negative control: without dismissPeek in setHoverMode it stays on screen)', 'runtime-peek-mode-off')
  assert('runtime-peek-gone', 'the faded card is removed', runtime.peek() === null)
  await sleep(420)

  runtime.schedulePeek(image)
  await sleep(420)
  assert('runtime-hover-off', 'mode off disables hover previews', runtime.peek() === null)
  assert('runtime-hover-persist', 'the hover mode is persisted', localStorageMock.value === 'off', String(localStorageMock.value))
  runtime.setHoverMode('peek')
  await sleep(420)

  // Owner-requested line: a real button «Откройте полный предпросмотр, чтобы
  // увидеть весь файл.» whenever the peek is incomplete, and none when complete.
  const notesCard = createNode('div', { 'data-presented-file': '' }, body)
  const notesButton = createNode('button', { title: 'D:/ws/notes.txt' }, notesCard)
  notesCard.children.push(notesButton)
  const shortCard = createNode('div', { 'data-presented-file': '' }, body)
  const shortButton = createNode('button', { title: 'D:/ws/short.txt' }, shortCard)
  shortCard.children.push(shortButton)
  await runtime.resolveDescriptor({ kind: 'file', path: 'D:/ws/short.txt' }, signal())
  await runtime.fetchText('D:/ws/short.txt', 4096, signal())

  await openPeekFor(notesButton)
  clickables.length = 0
  const truncatedMarkup = renderTree()
  assert(
    'runtime-peek-more-exact-text',
    'the full-preview line carries the exact owner-requested Russian text (negative control: any rewording fails)',
    dictionary.ru['hover.more'] === 'Откройте полный предпросмотр, чтобы увидеть весь файл.',
    dictionary.ru['hover.more']
  )
  const moreButton = clickables.find((entry) => entry.props.className === 'dfp-peek-more')
  assert(
    'runtime-peek-more-line',
    'a truncated text peek shows the full-preview line with the exact localized text as a real button (negative control: the old inline hint was not clickable)',
    truncatedMarkup.includes('dfp-peek-more') && truncatedMarkup.includes(dictionary.ru['hover.more']) && moreButton !== undefined,
    String(moreButton === undefined ? 'missing' : moreButton.props.className)
  )
  if (moreButton !== undefined) moreButton.props.onClick()
  assert(
    'runtime-peek-more-opens',
    'clicking the line opens the full preview for the same target (negative control: a dead line leaves the overlay null)',
    runtime.overlay() !== null && runtime.overlay().path === 'D:/ws/notes.txt',
    String(runtime.overlay() === null ? 'null' : runtime.overlay().path)
  )
  runtime.closePreview()
  await sleep(460)

  await openPeekFor(shortButton)
  const completeMarkup = renderTree()
  assert(
    'runtime-peek-more-absent',
    'a peek that shows the whole file renders no full-preview line (negative control: a dead line would appear here)',
    completeMarkup.includes('dfp-peek') && completeMarkup.includes('dfp-peek-more') === false,
    completeMarkup.slice(0, 200)
  )
  runtime.dismissPeek('test-cleanup')
  await sleep(460)

  // Both hover modes carry the same affordances: close X, full-preview line,
  // copy dropdown (the card component is shared, the assertion proves it).
  runtime.setHoverMode('full')
  await openPeekFor(notesButton)
  clickables.length = 0
  const fullMarkup = renderTree()
  assert(
    'runtime-peek-full-mode-affordances',
    'the full hover mode also renders the close X, the full-preview line and the copy dropdown (negative control: a mode-specific branch would drop one of them)',
    fullMarkup.includes('dfp-peek') &&
      fullMarkup.includes('data-mode="full"') &&
      buttonByAria(dictionary.ru['peek.close']) !== undefined &&
      buttonByAria(dictionary.ru['copy.toggle']) !== undefined &&
      fullMarkup.includes('dfp-peek-more') &&
      fullMarkup.includes(dictionary.ru['hover.more']),
    fullMarkup.slice(0, 200)
  )
  runtime.dismissPeek('test-cleanup')
  await sleep(460)
  runtime.setHoverMode('peek')
  await sleep(420)

  // Gated diagnostics line: counters behind the live investigation.
  localStorageMock.value = '1'
  await openPeekAndWait()
  const debugMarkup = renderTree()
  assert(
    'runtime-peek-debug-line',
    'with localStorage dsh-file-preview.debug=1 the card footer shows the counters (negative control: without the flag the line is absent)',
    debugMarkup.includes('dfp-peek-debug') && /dfp-peek-debug"[^>]*>[0-9]+:[0-9]+:/.test(debugMarkup)
  )
  assert('runtime-debug-counters', 'runtime.debug exposes the same counters (negative control: counters that never increment would fail here)', runtime.debug().open >= 1 && runtime.debug().dismiss >= 1)
  localStorageMock.value = 'off'
  runtime.dismissPeek('test-cleanup')
  await sleep(460)
  //#endregion

  for (const effect of effectDisposers) effect.dispose()
  assert('runtime-dispose-listeners', 'the ctx.effect disposer removes every window listener', listeners.size === 0, [...listeners.keys()].join(','))
  assert('runtime-dispose-cursor', 'the ctx.effect disposer removes the cursor rule', head.children.length === 0, String(head.children.length))
  assert('runtime-dispose-document', 'the ctx.effect disposer removes the document listener (negative control: a leaked listener keeps firing after unload)', documentListeners.size === 0, [...documentListeners.keys()].join(','))
  assert('runtime-dispose-poll', 'the ctx.effect disposer stops the pointer poll (negative control: a leaked interval keeps closing cards after unload)', intervals.size === 0, String(intervals.size))
  assert('runtime-dispose-slot', 'the shell.overlay registration is disposed', registration === null)

  const bareLanguages = []
  const effectsBefore = effectDisposers.length
  plugin.apply(
    Object.assign({}, ctx, {
      locale: Object.assign({}, ctx.locale, {
        addLanguage(language) {
          bareLanguages.push(language)
          return () => {}
        },
        getSnapshot: () => ({ active: 'en', locales: [{ id: 'en' }], revision: 1 })
      })
    })
  )
  assert('runtime-bare-language', 'without a language pack the plugin adds ru itself', bareLanguages.length === 1 && bareLanguages[0].id === 'ru')
  for (const effect of effectDisposers.slice(effectsBefore)) effect.dispose()
}
//#endregion

await runtimeChecks()

console.log('')
console.log(`SUMMARY ${passed + failed} assertions, ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
process.exit(0)
