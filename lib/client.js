/**
 * dsh-file-preview — browser half.
 *
 * Turns a click (and, in the two hover modes, a hover) on a file, image,
 * attachment or website link in the conversation into an in-chat preview
 * overlay, driven by the host half on `/api/dsh-file-preview`.
 *
 * Design notes
 * - One hand-authored bundle, no build step: React comes from the browser seed
 *   table, every other control (modal, focus trap, hover card, icons, markdown
 *   renderer) is implemented here so no Harness client package is loaded as a
 *   module (a thrown import would blank the slot).
 * - The factory is side-effect free: it only assembles values. Every listener,
 *   timer, observer and injected stylesheet is created inside `apply` and
 *   removed by its `ctx.effect` disposer, so unload and hot reload are clean.
 * - The overlay is rendered through a `shell.overlay` entry. That layer is
 *   click-through, so the plugin's own root opts back into pointer events and
 *   lives in a single fixed, pointer-events-none stacking root.
 * - All visible text is resolved through the `dsh-file-preview` locale
 *   namespace; the dictionaries below are verbatim copies of `locale/en.json`
 *   and `locale/ru.json` (the plugin loader serves only `client*.js` chunks, so
 *   the browser cannot fetch the JSON files at runtime). `scripts/check-client.mjs`
 *   enforces that the embedded copies and the JSON files stay identical.
 */

window.__ModuleLoader__.load({
  id: 'dsh-file-preview',
  factory(require) {
    /** The only module the browser seed table guarantees to a hand-written half. */
    const React = require('react')
    /** createElement alias: the bundle is hand-authored, so no JSX. */
    const h = React.createElement

    //#region Constants
    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-file-preview'
    /** Host route base (same-origin, loopback). */
    const API_BASE = '/api/dsh-file-preview'
    /** Host routes; every one of them is used by this half. */
    const ROUTES = {
      meta: '/meta',
      raw: '/raw',
      text: '/text',
      officePdf: '/office-pdf',
      link: '/link',
      action: '/action',
      status: '/status',
      resolve: '/resolve'
    }
    /** Slot entry id; fresh, so it sits beside the shipped overlay entries. */
    const OVERLAY_ID = 'file-preview.overlay'
    /** Hover behaviours the owner can switch at runtime. */
    const PEEK_MODES = ['peek', 'full', 'off']
    /** localStorage key holding the chosen hover mode. */
    const STORAGE_HOVER = 'dsh-file-preview.hover-mode'
    /** Hover delays, matched to the shipped HoverCard numbers. */
    const PEEK_DELAY_MS = 350
    const FULL_DELAY_MS = 450
    /** Grace period so the pointer can travel from the anchor into the card. */
    const PEEK_GRACE_MS = 120
    /** Opacity fade of the hover card (matches --dsh-hover-preview-fade). */
    const PEEK_FADE_MS = 100
    /**
     * Pointer watchdog of the hover card: pointerout alone is unreliable (a
     * removed anchor, a window switch or a stalled event leaves the card on
     * screen), so a pointermove far from the anchor and the card for this long
     * closes it, even when no further pointer event ever arrives.
     */
    const PEEK_WATCHDOG_MS = 200
    /** Slack around the anchor/card rects so edges do not flicker. */
    const WATCHDOG_SLACK = 4
    /**
     * While a card is open this interval re-checks what is actually under the
     * last known pointer point (`document.elementFromPoint`): the chat can
     * re-render the anchor away without any pointer event, which is how the card
     * used to stay on screen.
     */
    const PEEK_POLL_MS = 150
    /** Consecutive unrelated poll ticks needed before dismissing. */
    const PEEK_POLL_MISSES = 2
    /**
     * After a dismissal, ignore new hover targets for this long. The browser
     * fires a fresh `pointerover` on whatever sits under the cursor when the
     * card unmounts, which used to reopen the card immediately (the live bug).
     */
    const REOPEN_COOLDOWN_MS = 400
    /** localStorage flag that renders the hover diagnostics line. */
    const DEBUG_KEY = 'dsh-file-preview.debug'
    /**
     * One retry after this delay when the host's file copy reports a cold-start
     * timeout (`copy-file-failed` with a "timed out" message). Every other
     * failure is shown immediately.
     */
    const COPY_FILE_RETRY_MS = 150
    /** Hover card widths and height caps. */
    const PEEK_WIDTH = 380
    const FULL_WIDTH = 720
    const PEEK_MAX_HEIGHT = 420
    const FULL_MAX_HEIGHT = 520
    /** Viewport margin used for flipping and clamping. */
    const VIEWPORT_MARGIN = 8
    /** Gap between the anchor and the hover card. */
    const ANCHOR_GAP = 8
    /** Bounded text reads. */
    const TEXT_MAX_BYTES = 262144
    const HOVER_TEXT_BYTES = 4096
    const HOVER_FULL_TEXT_BYTES = 32768
    /** Hover media limits: a thumbnail must never pull a huge payload. */
    const HOVER_IMAGE_MAX_BYTES = 8 * 1024 * 1024
    const HOVER_PDF_MAX_BYTES = 6 * 1024 * 1024
    /** Above this line count the text viewer drops per-line nodes. */
    const MAX_TEXT_LINES = 5000
    /** Image zoom range required by the contract. */
    const ZOOM_MIN = 0.25
    const ZOOM_MAX = 8
    /** Lines shown by the compact hover card. */
    const PEEK_TEXT_LINES = 12
    /** Focusable selector of the modal focus trap. */
    const FOCUSABLE =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    /** Accessible name target of the dialog. */
    const TITLE_ID = 'dsh-file-preview-title'
    /** Marker attribute of the single injected cursor rule. */
    const CURSOR_ATTR = 'data-dsh-file-preview-cursor'
    /** Toast lifetime. */
    const TOAST_MS = 2400
    /** Exit animation duration of the modal (shorter than the enter). */
    const EXIT_MS = 140
    //#endregion

    //#region Dictionaries
    /**
     * English dictionary — verbatim copy of `locale/en.json`.
     * Keys are double-quoted and values are plain JSON so the check script can
     * parse the block and compare it with the served JSON file.
     */
    const EN = /* locale:en:begin */ {
      "entry.label": "In-chat file preview",
      "language.label": "Russian",
      "dialog.aria": "File preview",
      "dialog.close": "Close",
      "dialog.closeTitle": "Close (Esc)",
      "segment.label": "Hover preview",
      "segment.peek": "Peek",
      "segment.full": "Full",
      "segment.off": "Off",
      "segment.peekTitle": "Compact hover card",
      "segment.fullTitle": "Large hover popover",
      "segment.offTitle": "No hover preview",
      "header.size": "{size}",
      "header.modified": "{date}",
      "header.unknownSize": "Unknown size",
      "header.unknownDate": "Unknown date",
      "header.path": "Path",
      "header.badgeLink": "LINK",
      "header.badgeImage": "IMG",
      "header.badgeFile": "FILE",
      "header.zoom": "{percent}%",
      "viewer.zoomIn": "Zoom in (+)",
      "viewer.zoomOut": "Zoom out (-)",
      "viewer.zoomReset": "Reset zoom (0)",
      "viewer.fit": "Fit to window",
      "viewer.actual": "Actual size",
      "viewer.hint": "Double-click to switch between fit and actual size",
      "viewer.wrap": "Wrap",
      "viewer.nowrap": "No wrap",
      "viewer.source": "Source",
      "viewer.rendered": "Preview",
      "viewer.markdown": "Markdown",
      "viewer.text": "Text",
      "viewer.code": "Source code",
      "viewer.html": "HTML page",
      "viewer.pdf": "PDF document",
      "viewer.image": "Image",
      "viewer.video": "Video",
      "viewer.audio": "Audio",
      "viewer.office": "Office document",
      "viewer.binary": "Binary file",
      "viewer.iframe": "Document content",
      "viewer.details": "File details",
      "viewer.kind": "Kind",
      "viewer.kindFile": "File",
      "viewer.kindDirectory": "Folder",
      "viewer.kindOther": "Item",
      "viewer.size": "Size",
      "viewer.modified": "Modified",
      "viewer.extension": "Extension",
      "viewer.lines": "{count} lines",
      "viewer.imageAlt": "Preview of {name}",
      "viewer.empty": "This file is empty.",
      "viewer.documentFallback": "If the document stays blank, open it in the browser or with the default app.",
      "state.loading": "Loading preview…",
      "state.loadingBody": "Reading file details.",
      "state.loadingFile": "Reading the file…",
      "state.loadingDocument": "Rendering the document…",
      "state.loadingOffice": "Converting the document…",
      "state.loadingImage": "Loading the image…",
      "state.loadingMedia": "Loading the media…",
      "state.errorTitle": "Preview unavailable",
      "state.errorBody": "The preview could not be loaded.",
      "state.errorNetwork": "The preview service did not answer. Check the DSH host and try again.",
      "state.retry": "Try again",
      "state.code": "Failure code: {code}",
      "state.requestedPath": "Requested path: {path}",
      "state.codeHint": "Include this code and path when reporting the problem.",
      "state.outsideRootsTitle": "Outside the readable area",
      "state.outsideRootsBody": "The file is outside the folders this preview may read.",
      "state.readScopeHint": "The host plugin's readScope setting defines which folders are allowed.",
      "state.restartTitle": "Restart DSH to finish installing",
      "state.restartBody": "The file preview plugin is installed, but its host half does not answer yet. Restart DeepSeek Harness and try again.",
      "state.notFoundTitle": "File not found",
      "state.notFoundBody": "The file is no longer at this path.",
      "state.deniedTitle": "Permission denied",
      "state.deniedBody": "DSH is not allowed to read this file.",
      "state.tooLargeTitle": "File too large",
      "state.tooLargeBody": "This file is too large for an in-chat preview.",
      "state.binaryTitle": "No inline preview",
      "state.binaryBody": "This file type has no inline preview. Use the actions below to open it.",
      "state.officeUnavailable": "Office preview is unavailable on this machine (LibreOffice was not found). Open the document with the default app instead.",
      "state.officeFonts": "Some fonts are missing, so the converted document may look different.",
      "state.truncated": "Showing the first {size} of this file.",
      "state.encoding": "Detected encoding: {encoding}",
      "state.attachmentUnavailable": "This attachment is no longer on disk, so only its name is available.",
      "state.pathUnknown": "The file path is unknown, so file actions are disabled.",
      "state.remoteImage": "Remote image",
      "state.imageBlocked": "The image could not be loaded.",
      "web.title": "Website link",
      "web.host": "Site",
      "web.open": "Open in browser",
      "web.copy": "Copy link",
      "web.description": "No description was provided by the site.",
      "web.unavailable": "Link details are unavailable, but the link can still be opened.",
      "web.loading": "Fetching link details…",
      "action.copyPath": "Copy path",
      "action.copyText": "Copy contents",
      "action.copyImage": "Copy image",
      "action.copyLink": "Copy link",
      "action.copyHint": "Ctrl+C",
      "action.browser": "Open in browser",
      "action.browserHint": "Ctrl+B",
      "action.reveal": "Reveal in file manager",
      "action.revealHint": "Ctrl+E",
      "action.open": "Open with default app",
      "action.openHint": "Enter",
      "action.noPath": "The file path is unknown.",
      "action.noTarget": "Nothing to act on for this file.",
      "action.failedOpen": "Could not open the file with its default app.",
      "action.failedReveal": "Could not reveal the file in the file manager.",
      "action.failedBrowser": "Could not open the file in the browser.",
      "action.failedCopy": "Could not copy to the clipboard.",
      "action.imageCopyUnsupported": "This image cannot be copied as a bitmap.",
      "toast.copiedPath": "Path copied",
      "toast.copiedText": "Contents copied",
      "toast.copiedImage": "Image copied",
      "toast.copiedLink": "Link copied",
      "toast.opened": "Opened with the default app",
      "toast.revealed": "Revealed in the file manager",
      "toast.browserOpened": "Opened in the browser",
      "toast.failed": "The action failed",
      "hover.loading": "Loading preview…",
      "hover.open": "Open full preview",
      "hover.reveal": "Reveal in file manager",
      "hover.copyPath": "Copy path",
      "hover.firstLines": "First {count} lines",
      "hover.more": "Open the full preview for the whole file.",
      "hover.metaOnly": "Open the full preview to see the contents.",
      "hover.imageTooLarge": "Too large for a thumbnail",
      "hover.error": "Preview unavailable",
      "hover.documentHint": "Open the full preview to read this document.",
      "hover.officeHint": "Office documents are converted in the full preview.",
      "hover.zoomHint": "Click to enlarge",
      "hover.flashCopied": "Copied",
      "hover.flashFailed": "Failed",
      "peek.close": "Close preview",
      "copy.menu": "Copy options",
      "copy.toggle": "More copy options",
      "copy.path": "Copy path",
      "copy.contents": "Copy contents",
      "copy.file": "Copy file",
      "copy.contentsUnavailable": "This file has no text or image to copy",
      "copy.fileUnavailable": "Copying the file is not available on this host",
      "copy.fileFailed": "The file could not be copied",
      "toast.copiedFile": "File copied",
      "unit.byte": "{n} B",
      "unit.kilobyte": "{n} KB",
      "unit.megabyte": "{n} MB",
      "unit.gigabyte": "{n} GB",
      "key.ctrlC": "Ctrl+C",
      "key.ctrlB": "Ctrl+B",
      "key.ctrlE": "Ctrl+E",
      "key.enter": "Enter",
      "key.esc": "Esc",
      "key.cmdC": "⌘C",
      "key.cmdB": "⌘B",
      "key.cmdE": "⌘E",
      "error.boundaryTitle": "Preview crashed",
      "error.boundaryBody": "The preview hit an unexpected error and was closed safely.",
      "error.boundaryClose": "Dismiss"
    } /* locale:en:end */

    /**
     * Russian dictionary — verbatim copy of `locale/ru.json`.
     * The only place in this bundle where Cyrillic appears.
     */
    const RU = /* locale:ru:begin */ {
      "entry.label": "Предпросмотр файлов в чате",
      "language.label": "Русский",
      "dialog.aria": "Предпросмотр файла",
      "dialog.close": "Закрыть",
      "dialog.closeTitle": "Закрыть (Esc)",
      "segment.label": "Предпросмотр при наведении",
      "segment.peek": "Кратко",
      "segment.full": "Полно",
      "segment.off": "Выкл",
      "segment.peekTitle": "Компактная карточка при наведении",
      "segment.fullTitle": "Большая карточка при наведении",
      "segment.offTitle": "Без предпросмотра при наведении",
      "header.size": "{size}",
      "header.modified": "{date}",
      "header.unknownSize": "Размер неизвестен",
      "header.unknownDate": "Дата неизвестна",
      "header.path": "Путь",
      "header.badgeLink": "ССЫЛКА",
      "header.badgeImage": "ФОТО",
      "header.badgeFile": "ФАЙЛ",
      "header.zoom": "{percent}%",
      "viewer.zoomIn": "Увеличить (+)",
      "viewer.zoomOut": "Уменьшить (-)",
      "viewer.zoomReset": "Сбросить масштаб (0)",
      "viewer.fit": "По размеру окна",
      "viewer.actual": "Натуральный размер",
      "viewer.hint": "Двойной щелчок переключает вписывание и натуральный размер",
      "viewer.wrap": "Перенос",
      "viewer.nowrap": "Без переноса",
      "viewer.source": "Исходник",
      "viewer.rendered": "Предпросмотр",
      "viewer.markdown": "Markdown",
      "viewer.text": "Текст",
      "viewer.code": "Исходный код",
      "viewer.html": "HTML-страница",
      "viewer.pdf": "Документ PDF",
      "viewer.image": "Изображение",
      "viewer.video": "Видео",
      "viewer.audio": "Аудио",
      "viewer.office": "Документ Office",
      "viewer.binary": "Двоичный файл",
      "viewer.iframe": "Содержимое документа",
      "viewer.details": "Свойства файла",
      "viewer.kind": "Тип",
      "viewer.kindFile": "Файл",
      "viewer.kindDirectory": "Папка",
      "viewer.kindOther": "Элемент",
      "viewer.size": "Размер",
      "viewer.modified": "Изменён",
      "viewer.extension": "Расширение",
      "viewer.lines": "строк: {count}",
      "viewer.imageAlt": "Предпросмотр {name}",
      "viewer.empty": "Файл пуст.",
      "viewer.documentFallback": "Если документ остался пустым, откройте его в браузере или приложении по умолчанию.",
      "state.loading": "Загружаем предпросмотр…",
      "state.loadingBody": "Читаем свойства файла.",
      "state.loadingFile": "Читаем файл…",
      "state.loadingDocument": "Готовим документ…",
      "state.loadingOffice": "Конвертируем документ…",
      "state.loadingImage": "Загружаем изображение…",
      "state.loadingMedia": "Загружаем медиа…",
      "state.errorTitle": "Предпросмотр недоступен",
      "state.errorBody": "Не удалось загрузить предпросмотр.",
      "state.errorNetwork": "Служба предпросмотра не ответила. Проверьте хост DSH и повторите попытку.",
      "state.retry": "Повторить",
      "state.code": "Код ошибки: {code}",
      "state.requestedPath": "Запрошенный путь: {path}",
      "state.codeHint": "Укажите этот код и путь в сообщении о проблеме.",
      "state.outsideRootsTitle": "Файл вне доступной области",
      "state.outsideRootsBody": "Файл находится вне папок, которые разрешено читать предпросмотру.",
      "state.readScopeHint": "Настройка readScope в серверной части плагина определяет разрешённые папки.",
      "state.restartTitle": "Перезапустите DSH, чтобы завершить установку",
      "state.restartBody": "Плагин предпросмотра установлен, но его серверная часть ещё не отвечает. Перезапустите DeepSeek Harness и повторите попытку.",
      "state.notFoundTitle": "Файл не найден",
      "state.notFoundBody": "Файла по этому пути больше нет.",
      "state.deniedTitle": "Доступ запрещён",
      "state.deniedBody": "DSH не может прочитать этот файл.",
      "state.tooLargeTitle": "Файл слишком большой",
      "state.tooLargeBody": "Этот файл слишком велик для предпросмотра в чате.",
      "state.binaryTitle": "Встроенный предпросмотр недоступен",
      "state.binaryBody": "Для этого типа файла нет встроенного предпросмотра. Откройте его действиями ниже.",
      "state.officeUnavailable": "Предпросмотр Office на этой машине недоступен (LibreOffice не найден). Откройте документ приложением по умолчанию.",
      "state.officeFonts": "Часть шрифтов отсутствует, поэтому сконвертированный документ может выглядеть иначе.",
      "state.truncated": "Показаны первые {size} файла.",
      "state.encoding": "Определена кодировка: {encoding}",
      "state.attachmentUnavailable": "Этого вложения больше нет на диске, доступно только имя.",
      "state.pathUnknown": "Путь к файлу неизвестен, поэтому файловые действия отключены.",
      "state.remoteImage": "Внешнее изображение",
      "state.imageBlocked": "Не удалось загрузить изображение.",
      "web.title": "Ссылка на сайт",
      "web.host": "Сайт",
      "web.open": "Открыть в браузере",
      "web.copy": "Скопировать ссылку",
      "web.description": "Сайт не предоставил описание.",
      "web.unavailable": "Сведения о ссылке недоступны, но ссылку всё равно можно открыть.",
      "web.loading": "Загружаем сведения о ссылке…",
      "action.copyPath": "Скопировать путь",
      "action.copyText": "Скопировать содержимое",
      "action.copyImage": "Скопировать изображение",
      "action.copyLink": "Скопировать ссылку",
      "action.copyHint": "Ctrl+C",
      "action.browser": "Открыть в браузере",
      "action.browserHint": "Ctrl+B",
      "action.reveal": "Показать в проводнике",
      "action.revealHint": "Ctrl+E",
      "action.open": "Открыть приложением",
      "action.openHint": "Enter",
      "action.noPath": "Путь к файлу неизвестен.",
      "action.noTarget": "Для этого файла действие недоступно.",
      "action.failedOpen": "Не удалось открыть файл приложением по умолчанию.",
      "action.failedReveal": "Не удалось показать файл в проводнике.",
      "action.failedBrowser": "Не удалось открыть файл в браузере.",
      "action.failedCopy": "Не удалось скопировать в буфер обмена.",
      "action.imageCopyUnsupported": "Это изображение нельзя скопировать как растровое.",
      "toast.copiedPath": "Путь скопирован",
      "toast.copiedText": "Содержимое скопировано",
      "toast.copiedImage": "Изображение скопировано",
      "toast.copiedLink": "Ссылка скопирована",
      "toast.opened": "Открыто приложением по умолчанию",
      "toast.revealed": "Показано в проводнике",
      "toast.browserOpened": "Открыто в браузере",
      "toast.failed": "Действие не выполнено",
      "hover.loading": "Загружаем предпросмотр…",
      "hover.open": "Открыть полный предпросмотр",
      "hover.reveal": "Показать в проводнике",
      "hover.copyPath": "Скопировать путь",
      "hover.firstLines": "Первые строки: {count}",
      "hover.more": "Откройте полный предпросмотр, чтобы увидеть весь файл.",
      "hover.metaOnly": "Откройте полный предпросмотр, чтобы увидеть содержимое.",
      "hover.imageTooLarge": "Слишком велико для миниатюры",
      "hover.error": "Предпросмотр недоступен",
      "hover.documentHint": "Откройте полный предпросмотр, чтобы прочитать документ.",
      "hover.officeHint": "Документы Office конвертируются в полном предпросмотре.",
      "hover.zoomHint": "Нажмите, чтобы увеличить",
      "hover.flashCopied": "Скопировано",
      "hover.flashFailed": "Ошибка",
      "peek.close": "Закрыть предпросмотр",
      "copy.menu": "Варианты копирования",
      "copy.toggle": "Другие варианты копирования",
      "copy.path": "Копировать путь",
      "copy.contents": "Копировать содержимое",
      "copy.file": "Копировать файл",
      "copy.contentsUnavailable": "В этом файле нет текста или изображения для копирования",
      "copy.fileUnavailable": "Копирование файла недоступно на этом хосте",
      "copy.fileFailed": "Не удалось скопировать файл",
      "toast.copiedFile": "Файл скопирован",
      "unit.byte": "{n} Б",
      "unit.kilobyte": "{n} КБ",
      "unit.megabyte": "{n} МБ",
      "unit.gigabyte": "{n} ГБ",
      "key.ctrlC": "Ctrl+C",
      "key.ctrlB": "Ctrl+B",
      "key.ctrlE": "Ctrl+E",
      "key.enter": "Enter",
      "key.esc": "Esc",
      "key.cmdC": "⌘C",
      "key.cmdB": "⌘B",
      "key.cmdE": "⌘E",
      "error.boundaryTitle": "Предпросмотр упал",
      "error.boundaryBody": "Предпросмотр столкнулся с непредвиденной ошибкой и был безопасно закрыт.",
      "error.boundaryClose": "Закрыть"
    } /* locale:ru:end */
    //#endregion

    //#region Pure helpers
    /** `true` under a Mac user agent (only used for the hotkey chips). */
    function isMac() {
      try {
        const agent = typeof navigator === 'undefined' ? '' : String(navigator.platform || navigator.userAgent || '')
        return /Mac|iPhone|iPad|iPod/i.test(agent)
      } catch (_error) {
        return false
      }
    }

    /** The document base, guarded (the Desktop shell runs on `dsh-app://app/`). */
    function baseUri() {
      try {
        if (typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== '') {
          return document.baseURI
        }
      } catch (_error) {
        /* fall through to location */
      }
      try {
        return location.href
      } catch (_error) {
        return '/'
      }
    }

    /** Origin used for API calls, valid for `http(s)://` and `dsh-app://`. */
    function apiRoot() {
      try {
        const url = new URL(baseUri())
        if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
        if (url.protocol === 'file:') {
          return typeof location !== 'undefined' && location.origin !== 'null' ? location.origin : ''
        }
        return url.protocol + '//' + url.host
      } catch (_error) {
        try {
          return location.origin === 'null' ? '' : location.origin
        } catch (_inner) {
          return ''
        }
      }
    }

    /**
     * Build one host URL.
     * @param route - key of {@link ROUTES}.
     * @param params - query values; empty values are dropped.
     * @returns the absolute same-origin URL.
     */
    function apiUrl(route, params) {
      const search = new URLSearchParams()
      if (params !== undefined && params !== null) {
        for (const key of Object.keys(params)) {
          const value = params[key]
          if (value === undefined || value === null || value === '') continue
          search.set(key, String(value))
        }
      }
      const query = search.toString()
      return apiRoot() + API_BASE + ROUTES[route] + (query === '' ? '' : '?' + query)
    }

    /** Clamp a number into a range. */
    function clamp(value, low, high) {
      if (!Number.isFinite(value)) return low
      return value < low ? low : value > high ? high : value
    }

    /** Last path segment of a POSIX or Windows path. */
    function pathBasename(value) {
      const text = String(value === undefined || value === null ? '' : value).replace(/[\\/]+$/, '')
      const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
      return cut === -1 ? text : text.slice(cut + 1)
    }

    /** Lowercase extension without the dot, ignoring any `#line` suffix. */
    function pathExtension(value) {
      const name = pathBasename(value).replace(/[#:]\d+(?:-\d+)?$/, '')
      const dot = name.lastIndexOf('.')
      if (dot <= 0 || dot === name.length - 1) return ''
      return name.slice(dot + 1).toLowerCase()
    }

    /** `true` for absolute POSIX, Windows drive and UNC paths. */
    function isAbsolutePath(value) {
      if (typeof value !== 'string' || value === '') return false
      return /^[A-Za-z]:[\\/]/.test(value) || /^[/\\]{1,2}/.test(value)
    }

    /** `true` when the text plausibly names a workspace/host file. */
    function looksLikePath(value) {
      if (typeof value !== 'string') return false
      const text = value.trim()
      if (text === '' || text.length > 400) return false
      if (/[\r\n\t]/.test(text)) return false
      if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) return false
      if (/^[A-Za-z][A-Za-z0-9+.-]*:@/.test(text)) return false
      if (/^(?:mailto|tel|javascript|data|blob):/i.test(text)) return false
      const separator = /[\\/]/.test(text) || /^[A-Za-z]:/.test(text)
      const extension = /\.[A-Za-z0-9]{1,10}(?:[#:]\d+(?:-\d+)?)?$/.test(text)
      return extension || separator
    }

    /** `true` when the raw URL points at the Host file route (`api/file?path=`). */
    function isApiFileUrl(value) {
      if (typeof value !== 'string') return false
      return /(?:^|\/)api\/file(?:[?#]|$)/.test(value)
    }

    /**
     * Decode the `path` parameter of an `api/file?path=` URL.
     * @param value - absolute or relative URL text.
     * @returns the decoded path, or undefined.
     */
    function filePathFromUrl(value) {
      if (!isApiFileUrl(value)) return undefined
      const mark = value.indexOf('?')
      if (mark === -1) return undefined
      let query = value.slice(mark + 1)
      const hash = query.indexOf('#')
      if (hash !== -1) query = query.slice(0, hash)
      try {
        const path = new URLSearchParams(query).get('path')
        return path === null || path === '' ? undefined : path
      } catch (_error) {
        return undefined
      }
    }

    /** Absolute path of a `file:` URL, Windows leading slash removed. */
    function pathFromFileUrl(value) {
      try {
        const url = new URL(value)
        if (url.protocol !== 'file:') return undefined
        let path = url.pathname || ''
        try {
          path = decodeURIComponent(path)
        } catch (_error) {
          /* keep the raw path */
        }
        if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1)
        if (path === '' || path === '/') return undefined
        return path
      } catch (_error) {
        return undefined
      }
    }

    /** `true` for a local scheme that already carries bytes (`blob:`, `data:`, `file:`). */
    function isLocalScheme(value) {
      return typeof value === 'string' && /^(?:blob|data|file):/i.test(value)
    }

    /** `true` for `http:` / `https:` URLs. */
    function isWebUrl(value) {
      return typeof value === 'string' && /^https?:/i.test(value)
    }

    /** Shorten the middle of a long file name for the header and the hover card. */
    function middleTruncate(value, head, tail) {
      const text = String(value === undefined || value === null ? '' : value)
      const front = typeof head === 'number' ? head : 26
      const back = typeof tail === 'number' ? tail : 14
      if (text.length <= front + back + 1) return text
      return text.slice(0, front) + '…' + text.slice(text.length - back)
    }

    /** `true` for the preview kinds rendered as text. */
    function isTextPreview(preview) {
      return preview === 'text' || preview === 'markdown' || preview === 'code'
    }

    /** Extensions the shipped markdown hover card already previews itself. */
    const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic', 'tif', 'tiff']

    /** `true` when the path names an image the shipped HoverCard already shows. */
    function isImageExtension(path) {
      return IMAGE_EXTENSIONS.indexOf(pathExtension(path)) !== -1
    }
    //#endregion

    //#region Small state utilities
    /** A minimal external store: one value, many subscribers, no framework. */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: function () {
          return value
        },
        set: function (next) {
          if (Object.is(next, value)) return
          value = next
          for (const listener of Array.from(listeners)) {
            try {
              listener()
            } catch (_error) {
              /* one crashed subscriber must not stop the others */
            }
          }
        },
        subscribe: function (listener) {
          listeners.add(listener)
          return function () {
            listeners.delete(listener)
          }
        }
      }
    }

    /** Subscribe a component to a store and re-render on change. */
    function useStore(store) {
      const [value, setValue] = React.useState(function () {
        return store.get()
      })
      React.useEffect(
        function () {
          return store.subscribe(function () {
            setValue(store.get())
          })
        },
        [store]
      )
      return value
    }

    /** Re-render a component whenever the active locale or its dictionaries change. */
    function useLocale(runtime) {
      const [, bump] = React.useState(0)
      React.useEffect(
        function () {
          return runtime.subscribeLocale(function () {
            bump(function (value) {
              return value + 1
            })
          })
        },
        [runtime]
      )
      return runtime.t
    }

    /** `true` for a DOM element (also true across frames is not needed here). */
    function isElement(value) {
      return typeof Element !== 'undefined' && value instanceof Element
    }

    /** A stable identity for one preview descriptor. */
    function descriptorKey(descriptor) {
      if (descriptor === null || descriptor === undefined) return ''
      return [
        String(descriptor.kind || ''),
        String(descriptor.path || ''),
        String(descriptor.name || ''),
        String(descriptor.url || ''),
        String(descriptor.src || '')
      ].join('\u0000')
    }

    /** Cache key of one resolved file path. */
    function metaKey(path) {
      return String(path)
    }

    /** Chosen hover mode, persisted for the owner's A/B testing. */
    function readHoverMode() {
      try {
        const stored = localStorage.getItem(STORAGE_HOVER)
        if (typeof stored === 'string' && PEEK_MODES.indexOf(stored) !== -1) return stored
      } catch (_error) {
        /* storage can be blocked; the default still works */
      }
      return 'peek'
    }

    /** Persist the hover mode; a blocked storage keeps the in-memory value. */
    function writeHoverMode(mode) {
      try {
        localStorage.setItem(STORAGE_HOVER, mode)
      } catch (_error) {
        /* ignore */
      }
    }

    /**
     * Classify a click/pointer target into a preview descriptor.
     * Only the markers that actually exist in the shipped chat DOM are used:
     * `a[href]`, `img[src]`, `[data-presented-file] button`, the markdown file
     * link button, and the user-attachment card (`[data-message-attachments]`).
     * The changed-files card keeps its shipped diff review and is never taken
     * over, and anything unrecognised falls through untouched.
     * @param target - the event target.
     * @returns a descriptor, or null to leave the event alone.
     */
    function classifyTarget(target) {
      const element = isElement(target) ? target : target !== null && target !== undefined && isElement(target.parentElement) ? target.parentElement : null
      if (element === null) return null
      if (element.closest('[data-dsh-file-preview-root]') !== null) return null

      // 1. Anchors: website links, file URLs, api/file URLs, blob/data media.
      const anchor = element.closest('a[href]')
      if (anchor !== null) {
        const href = String(anchor.getAttribute('href') || '').trim()
        if (href !== '') {
          const filePath = filePathFromUrl(href)
          if (filePath !== undefined) {
            return { kind: 'file', path: filePath, name: pathBasename(filePath), sourceEl: anchor, origin: 'anchor' }
          }
          if (isLocalScheme(href)) {
            const local = pathFromFileUrl(href)
            if (local !== undefined) {
              return { kind: 'file', path: local, name: pathBasename(local), sourceEl: anchor, origin: 'anchor' }
            }
            return { kind: 'image-src', src: href, name: pathBasename(String(anchor.textContent || '')) || undefined, sourceEl: anchor, origin: 'anchor' }
          }
          if (isWebUrl(href)) return { kind: 'web', url: href, name: '', sourceEl: anchor, origin: 'anchor' }
        }
      }

      // 2. Deliverables / turn-tail file card: the absolute path is the title.
      const presented = element.closest('[data-presented-file]')
      if (presented !== null) {
        const button = presented.querySelector('button[title], button[aria-label]')
        const title = button === null ? '' : String(button.getAttribute('title') || '').trim()
        if (looksLikePath(title)) {
          return { kind: 'file', path: title, name: pathBasename(title), sourceEl: button || presented, origin: 'presented' }
        }
        const label = button === null ? '' : String(button.getAttribute('aria-label') || '').trim()
        const visible = String(presented.textContent || '').trim()
        const name = pathBasename(label !== '' ? label : visible.split(/\s+/)[0] || '')
        if (name !== '') return { kind: 'attachment', name: name, sourceEl: presented, origin: 'presented' }
      }

      // 3. Images: api/file carries the path, blob/data/http carry the bytes.
      const image = element.closest('img[src]')
      if (image !== null) {
        const src = String(image.getAttribute('src') || '').trim()
        const filePath = filePathFromUrl(src)
        if (filePath !== undefined) {
          return { kind: 'file', path: filePath, name: pathBasename(filePath), sourceEl: image, origin: 'image' }
        }
        if (isLocalScheme(src) || isWebUrl(src)) {
          const alt = String(image.getAttribute('alt') || '').trim()
          return {
            kind: 'image-src',
            src: String(image.currentSrc || src),
            name: alt !== '' ? alt : undefined,
            sourceEl: image,
            origin: 'image'
          }
        }
      }

      // 4. Markdown file link: a button, path in title (or the label itself).
      const button = element.closest('button')
      if (button !== null) {
        const className = typeof button.className === 'string' ? button.className : ''
        const isFileLink = /file(?:Link|Mention)/.test(className)
        const title = String(button.getAttribute('title') || '').trim()
        const text = String(button.textContent || '').trim()
        const candidate = isFileLink ? (title !== '' ? title : text) : title !== '' && looksLikePath(title) && /\s/.test(title) === false ? title : ''
        if (candidate !== '' && looksLikePath(candidate)) {
          return { kind: 'file', path: candidate, name: pathBasename(candidate), sourceEl: button, origin: 'link' }
        }
        if (isFileLink && looksLikePath(text)) {
          return { kind: 'file', path: text, name: pathBasename(text), sourceEl: button, origin: 'link' }
        }
      }

      // 5. User attachment card: only a display name reaches the DOM.
      const row = element.closest('[data-message-attachments]')
      if (row !== null) {
        const card = element.closest('[title]')
        const name = card === null ? '' : String(card.getAttribute('title') || '').trim()
        if (name !== '') return { kind: 'attachment', name: name, sourceEl: card, origin: 'attachment' }
        const visible = String(element.textContent || '').trim()
        if (visible !== '') {
          const first = visible.split(/\s+/)[0]
          if (first !== undefined && first !== '') {
            return { kind: 'attachment', name: pathBasename(first), sourceEl: element, origin: 'attachment' }
          }
        }
      }

      return null
    }
    //#endregion

    //#region Runtime
    /**
     * Assemble everything the React tree and the window listeners share.
     * Nothing here subscribes, schedules or touches the DOM: that only happens
     * in `apply` and inside component effects.
     * @param ctx - the client plugin context.
     * @returns the runtime face used by the controllers and the components.
     */
    function createRuntime(ctx) {
      /** Overlay (modal) store: null when closed. */
      const overlayStore = createStore(null)
      /** Hover card store: null when nothing is shown. */
      const peekStore = createStore(null)
      /** Hover mode store, mirrored from localStorage. */
      const modeStore = createStore(readHoverMode())
      /** Resolved `/meta` answers, session-lifetime. */
      const metaCache = new Map()
      /** Last known failure per path, so a reopened error paints instantly. */
      const failureCache = new Map()
      /** Resolved `/text` answers keyed by path and byte budget. */
      const textCache = new Map()
      /** Resolved `/link` answers keyed by URL. */
      const linkCache = new Map()
      /** Object URLs of preview images, LRU-capped and revoked on dispose. */
      const imageCache = new Map()
      /** Locale translate function; missing keys fall back to the key. */
      const bound = (function () {
        try {
          return ctx.locale.bind(NS)
        } catch (_error) {
          return function (key) {
            return key
          }
        }
      })()

      let seat = 'mounted'
      let rootEl = null
      let popoverEl = null
      let openToken = 0
      let disposed = false
      let menuOpen = false
      /** Counters of the gated hover diagnostics line (localStorage flag). */
      const debugState = { open: 0, dismiss: 0, lastSource: 'none' }

      /** Hover controller state: exactly one timer, one anchor, one card. */
      const hover = {
        mode: modeStore.get(),
        timer: 0,
        grace: 0,
        fade: 0,
        watchdog: 0,
        poll: 0,
        pollMisses: 0,
        hasPoint: false,
        lastX: 0,
        lastY: 0,
        fadeHard: 0,
        suppressUntil: 0,
        key: '',
        anchor: null,
        nonce: 0
      }

      /**
       * Translate through the plugin namespace.
       * @param key - dictionary key.
       * @param params - `{name}` interpolation values.
       * @returns the localized string, or the key when the locale is unavailable.
       */
      function t(key, params) {
        try {
          return bound(key, params)
        } catch (_error) {
          return key
        }
      }

      /** Subscribe to locale/dictionary changes without throwing. */
      function subscribeLocale(listener) {
        try {
          const dispose = ctx.locale.subscribe(listener)
          return typeof dispose === 'function' ? dispose : function () {}
        } catch (_error) {
          return function () {}
        }
      }

      /** The active locale id, used only for `Intl` date formatting. */
      function activeLocale() {
        try {
          const snapshot = ctx.locale.getSnapshot()
          if (snapshot !== null && typeof snapshot === 'object') {
            if (typeof snapshot.active === 'string' && snapshot.active !== '') return snapshot.active
          }
        } catch (_error) {
          /* fall through */
        }
        return 'en'
      }

      /** Current session working directory, used to resolve relative paths. */
      function sessionCwd() {
        try {
          const sessions = ctx.sessions
          if (sessions === null || sessions === undefined || sessions.list === undefined) return undefined
          const list = sessions.list.getSnapshot()
          if (list === null || typeof list !== 'object' || list.byId === null || typeof list.byId !== 'object') return undefined
          const ids = Array.isArray(list.ids) ? list.ids : Object.keys(list.byId)
          let fallback
          for (let index = ids.length - 1; index >= 0; index -= 1) {
            const row = list.byId[ids[index]]
            if (row === null || row === undefined || typeof row.cwd !== 'string' || row.cwd === '') continue
            if (fallback === undefined) fallback = row.cwd
            try {
              const retained = sessions.retainInfo(ids[index]).getSnapshot().retainedBy
              if (retained !== null && retained !== undefined && retained.mainView > 0) return row.cwd
            } catch (_error) {
              /* retainInfo can be unavailable during startup */
            }
          }
          return fallback
        } catch (_error) {
          return undefined
        }
      }

      /** `true` when the user asks for reduced motion. */
      function reducedMotion() {
        try {
          return window.matchMedia('(prefers-reduced-motion: reduce)').matches
        } catch (_error) {
          return false
        }
      }

      /** `{n} B` … `{n} GB`, localized units only. */
      function formatBytes(bytes) {
        const value = Number(bytes)
        if (!Number.isFinite(value) || value < 0) return t('header.unknownSize')
        if (value < 1024) return t('unit.byte', { n: String(Math.round(value)) })
        if (value < 1024 * 1024) return t('unit.kilobyte', { n: (value / 1024).toFixed(value < 10240 ? 1 : 0) })
        if (value < 1024 * 1024 * 1024) {
          return t('unit.megabyte', { n: (value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0) })
        }
        return t('unit.gigabyte', { n: (value / (1024 * 1024 * 1024)).toFixed(1) })
      }

      /** Localized date/time of a file modification. */
      function formatDate(ms) {
        const value = Number(ms)
        if (!Number.isFinite(value) || value <= 0) return t('header.unknownDate')
        try {
          return new Intl.DateTimeFormat(activeLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
        } catch (_error) {
          return t('header.unknownDate')
        }
      }

      /** The platform hotkey chip of one action. */
      function keyChip(kind) {
        const mac = isMac()
        if (kind === 'copy') return t(mac ? 'key.cmdC' : 'key.ctrlC')
        if (kind === 'browser') return t(mac ? 'key.cmdB' : 'key.ctrlB')
        if (kind === 'reveal') return t(mac ? 'key.cmdE' : 'key.ctrlE')
        return t('key.enter')
      }

      /** The `aria-keyshortcuts` value of one action (real key names, not a hint). */
      function keyAria(kind) {
        const mac = isMac()
        if (kind === 'copy') return mac ? 'Meta+C' : 'Control+C'
        if (kind === 'browser') return mac ? 'Meta+B' : 'Control+B'
        if (kind === 'reveal') return mac ? 'Meta+E' : 'Control+E'
        return 'Enter'
      }

      /**
       * JSON request that never throws.
       * @param url - absolute URL.
       * @param signal - abort signal of the requesting view.
       * @returns `{status, body}`; status 0 is a transport failure, -2 an abort.
       */
      async function requestJson(url, signal) {
        try {
          const response = await fetch(url, {
            signal: signal,
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { accept: 'application/json' }
          })
          let body = null
          try {
            body = await response.json()
          } catch (_error) {
            body = null
          }
          return { status: response.status, body: body }
        } catch (error) {
          if (error !== null && error !== undefined && (error.name === 'AbortError' || (signal !== undefined && signal.aborted === true))) {
            return { status: -2, body: null }
          }
          return { status: 0, body: null }
        }
      }

      /**
       * Turn a host answer into a failure state, or null when it succeeded.
       * A response that is not the plugin's JSON envelope means the host half
       * did not answer (the route is missing and the SPA fallback replied).
       */
      function failureOf(answer) {
        if (answer === null || answer === undefined) return { phase: 'error', code: 'network' }
        if (answer.status === -2) return { phase: 'aborted' }
        if (answer.status === 0) return { phase: 'error', code: 'network' }
        const body = answer.body
        if (body === null || typeof body !== 'object' || typeof body.ok !== 'boolean') return { phase: 'hostMissing' }
        if (body.ok === true) return null
        return { phase: 'error', code: typeof body.code === 'string' && body.code !== '' ? body.code : 'unknown' }
      }

      /** Normalize a `/meta` body into the shape the views consume. */
      function normalizeMeta(body, requested, cwd) {
        const absPath =
          typeof body.absPath === 'string' && body.absPath !== ''
            ? body.absPath
            : isAbsolutePath(requested)
              ? requested
              : undefined
        const name =
          typeof body.name === 'string' && body.name !== '' ? body.name : pathBasename(absPath !== undefined ? absPath : requested)
        return {
          absPath: absPath,
          relPath: absPath === undefined ? requested : undefined,
          cwd: cwd,
          name: name,
          ext:
            typeof body.ext === 'string' && body.ext !== ''
              ? body.ext.replace(/^\./, '').toLowerCase()
              : pathExtension(absPath !== undefined ? absPath : requested),
          size: Number.isFinite(body.size) ? body.size : undefined,
          mtimeMs: Number.isFinite(body.mtimeMs) ? body.mtimeMs : undefined,
          preview: typeof body.preview === 'string' && body.preview !== '' ? body.preview : 'none',
          kind: typeof body.kind === 'string' ? body.kind : undefined,
          officeExt: typeof body.officeExt === 'string' ? body.officeExt : undefined,
          mime: typeof body.mime === 'string' ? body.mime : undefined,
          // The host may know the file but not be allowed to read it.
          canRead: body.canRead !== false,
          reason: typeof body.reason === 'string' ? body.reason : undefined
        }
      }

      /**
       * Resolve one descriptor to metadata (`/meta`, `/resolve` for attachments).
       * @param descriptor - what was clicked.
       * @param signal - view lifetime.
       * @param options - `{force:true}` re-reads `/meta` instead of using the cache
       *   (the modal refreshes; hover reads the session cache).
       * @returns `{phase:'ready'|'error'|'hostMissing'|'nameOnly'|'aborted', …}`.
       */
      async function resolveDescriptor(descriptor, signal, options) {
        try {
          const force = options !== null && options !== undefined && options.force === true
          if (descriptor === null || descriptor === undefined) return { phase: 'error', code: 'no-target' }
          if (descriptor.kind === 'image-src') {
            return {
              phase: 'ready',
              meta: null,
              remote: { src: descriptor.src, name: descriptor.name },
              hostMissing: false
            }
          }
          const requested = typeof descriptor.path === 'string' && descriptor.path !== '' ? descriptor.path : undefined
          const cwd = typeof descriptor.cwd === 'string' && descriptor.cwd !== '' ? descriptor.cwd : sessionCwd()
          if (requested !== undefined) {
            // A relative path only means something together with its session cwd.
            const cacheKey = isAbsolutePath(requested) ? requested : String(cwd || '') + '\u0000' + requested
            const cached = force === true ? undefined : metaCache.get(metaKey(cacheKey))
            if (cached !== undefined) return { phase: 'ready', meta: cached }
            // A path that just failed paints its error instantly on reopen; the
            // modal's forced read below still refreshes and clears it.
            const remembered = force === true ? undefined : failureCache.get(metaKey(cacheKey))
            if (remembered !== undefined) return remembered
            const answer = await requestJson(apiUrl('meta', { path: requested, cwd: cwd, seat: seat }), signal)
            const failure = failureOf(answer)
            if (failure !== null) {
              if (failure.phase !== 'aborted') failureCache.set(metaKey(cacheKey), failure)
              return failure
            }
            const meta = normalizeMeta(answer.body, requested, cwd)
            failureCache.delete(metaKey(cacheKey))
            metaCache.set(metaKey(cacheKey), meta)
            return { phase: 'ready', meta: meta }
          }
          const name = typeof descriptor.name === 'string' ? descriptor.name : ''
          if (name !== '') {
            const resolved = await requestJson(apiUrl('resolve', { name: name, cwd: cwd, seat: seat }), signal)
            const resolvedFailure = failureOf(resolved)
            if (resolvedFailure !== null && resolvedFailure.phase === 'aborted') return resolvedFailure
            let foundPath
            if (resolved.body !== null && typeof resolved.body === 'object' && resolved.body.ok === true) {
              if (typeof resolved.body.absPath === 'string' && resolved.body.absPath !== '') foundPath = resolved.body.absPath
              else if (typeof resolved.body.path === 'string' && resolved.body.path !== '') foundPath = resolved.body.path
            }
            if (foundPath !== undefined) {
              const answer = await requestJson(apiUrl('meta', { path: foundPath, cwd: cwd, seat: seat }), signal)
              if (answer.body !== null && typeof answer.body === 'object' && answer.body.ok === true) {
                const meta = normalizeMeta(answer.body, foundPath, cwd)
                metaCache.set(metaKey(foundPath), meta)
                return { phase: 'ready', meta: meta }
              }
            }
            // Second chance: the display name may be a workspace-relative path.
            const direct = await requestJson(apiUrl('meta', { path: name, cwd: cwd, seat: seat }), signal)
            if (direct.body !== null && typeof direct.body === 'object' && direct.body.ok === true) {
              const meta = normalizeMeta(direct.body, name, cwd)
              metaCache.set(metaKey(String(cwd || '') + '\u0000' + name), meta)
              return { phase: 'ready', meta: meta }
            }
            if (resolvedFailure !== null && resolvedFailure.phase === 'hostMissing') return resolvedFailure
            return { phase: 'nameOnly', name: name }
          }
          return { phase: 'error', code: 'no-target' }
        } catch (_error) {
          return { phase: 'error', code: 'network' }
        }
      }

      /**
       * Read `/text` with a byte budget; results are cached per path and budget.
       */
      async function fetchText(path, maxBytes, signal) {
        const key = String(path) + '#' + String(maxBytes)
        const cached = textCache.get(key)
        if (cached !== undefined) return cached
        const params = pathParams(path)
        params.maxBytes = maxBytes
        const answer = await requestJson(apiUrl('text', params), signal)
        const failure = failureOf(answer)
        if (failure !== null) return failure
        const body = answer.body
        const value = {
          phase: 'ready',
          text: typeof body.text === 'string' ? body.text : '',
          truncated: body.truncated === true,
          encoding: typeof body.encoding === 'string' ? body.encoding : undefined
        }
        textCache.set(key, value)
        return value
      }

      /** One copy of the path query parameters; `cwd` matters for relative paths. */
      function pathParams(path) {
        const params = { path: path, seat: seat }
        if (isAbsolutePath(path) !== true) params.cwd = sessionCwd()
        return params
      }

      /** Read `/raw` bytes as a Blob. */
      async function fetchRawBlob(path, signal) {
        try {
          const response = await fetch(apiUrl('raw', pathParams(path)), { signal: signal, cache: 'no-store' })
          if (!response.ok) {
            return { phase: 'error', code: response.status === 404 ? 'not-found' : 'raw-' + String(response.status) }
          }
          const type = String(response.headers.get('content-type') || '')
          // The SPA fallback answers HTML when the host half is not mounted.
          if (/text\/html/i.test(type)) return { phase: 'hostMissing' }
          const blob = await response.blob()
          return { phase: 'ready', blob: blob }
        } catch (error) {
          if (error !== null && error !== undefined && (error.name === 'AbortError' || (signal !== undefined && signal.aborted === true))) {
            return { phase: 'aborted' }
          }
          return { phase: 'error', code: 'network' }
        }
      }

      /** Drop the least recently used preview images, revoking their URLs. */
      function trimImageCache() {
        while (imageCache.size > 24) {
          const oldest = imageCache.keys().next()
          if (oldest.done === true) return
          const url = imageCache.get(oldest.value)
          imageCache.delete(oldest.value)
          try {
            URL.revokeObjectURL(url)
          } catch (_error) {
            /* already revoked */
          }
        }
      }

      /** Object URL of a preview image, cached for the page lifetime. */
      async function imageUrlFor(path, signal) {
        const cached = imageCache.get(path)
        if (cached !== undefined) return { phase: 'ready', url: cached }
        const raw = await fetchRawBlob(path, signal)
        if (raw.phase !== 'ready') return raw
        let url
        try {
          url = URL.createObjectURL(raw.blob)
        } catch (_error) {
          return { phase: 'error', code: 'blob' }
        }
        imageCache.set(path, url)
        trimImageCache()
        return { phase: 'ready', url: url }
      }

      /** Convert an Office document to a PDF object URL through the host. */
      async function officePdfUrl(path, signal) {
        try {
          const response = await fetch(apiUrl('officePdf', pathParams(path)), { signal: signal, cache: 'no-store' })
          if (!response.ok) {
            let body = null
            try {
              body = await response.json()
            } catch (_error) {
              body = null
            }
            if (body !== null && typeof body === 'object' && typeof body.ok === 'boolean') {
              const code = typeof body.code === 'string' && body.code !== '' ? body.code : 'office-unavailable'
              if (code === 'office-unavailable' || code === 'unavailable') return { phase: 'unavailable', code: code }
              return { phase: 'error', code: code }
            }
            if (response.status === 404 || response.status === 501 || response.status === 503) return { phase: 'hostMissing' }
            return { phase: 'error', code: 'office-' + String(response.status) }
          }
          const blob = await response.blob()
          const fontsHeader = String(response.headers.get('x-dsh-missing-fonts') || '')
          let url
          try {
            url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
          } catch (_error) {
            return { phase: 'error', code: 'blob' }
          }
          return { phase: 'ready', url: url, missingFonts: fontsHeader !== '' }
        } catch (error) {
          if (error !== null && error !== undefined && (error.name === 'AbortError' || (signal !== undefined && signal.aborted === true))) {
            return { phase: 'aborted' }
          }
          return { phase: 'error', code: 'network' }
        }
      }

      /** Read `/link` metadata; a failed read still renders an openable card. */
      async function fetchLink(url, signal) {
        const cached = linkCache.get(String(url))
        if (cached !== undefined) return cached
        const answer = await requestJson(apiUrl('link', { url: url, seat: seat }), signal)
        if (answer.status === -2) return { phase: 'aborted' }
        const failure = failureOf(answer)
        if (failure !== null) return { phase: 'linkFallback', url: url, hostMissing: failure.phase === 'hostMissing' }
        const body = answer.body
        const value = {
          phase: 'ready',
          link: {
            url: typeof body.url === 'string' && body.url !== '' ? body.url : url,
            host: typeof body.host === 'string' ? body.host : '',
            title: typeof body.title === 'string' ? body.title : '',
            description: typeof body.description === 'string' ? body.description : '',
            siteName: typeof body.siteName === 'string' ? body.siteName : '',
            icon: typeof body.icon === 'string' ? body.icon : '',
            image: typeof body.image === 'string' ? body.image : '',
            // The host may return url/host while the page read failed.
            partial: typeof body.error === 'string' && body.error !== ''
          }
        }
        linkCache.set(String(url), value)
        return value
      }

      /** Synchronous cache reads that let a reopened view paint without a flash. */
      function cachedMeta(descriptor) {
        try {
          if (descriptor === null || descriptor === undefined) return undefined
          if (descriptor.kind === 'image-src') {
            return { phase: 'ready', meta: null, remote: { src: descriptor.src, name: descriptor.name } }
          }
          const requested = typeof descriptor.path === 'string' ? descriptor.path : ''
          if (requested === '') return undefined
          const cwd = typeof descriptor.cwd === 'string' && descriptor.cwd !== '' ? descriptor.cwd : sessionCwd()
          const cacheKey = isAbsolutePath(requested) ? requested : String(cwd || '') + '\u0000' + requested
          const cached = metaCache.get(metaKey(cacheKey))
          if (cached !== undefined) return { phase: 'ready', meta: cached }
          const remembered = failureCache.get(metaKey(cacheKey))
          return remembered === undefined ? undefined : remembered
        } catch (_error) {
          return undefined
        }
      }

      /** Cached `/text` answer for one path and budget. */
      function cachedText(path, maxBytes) {
        const cached = textCache.get(String(path) + '#' + String(maxBytes))
        return cached === undefined ? undefined : cached
      }

      /** Cached object URL of one preview image. */
      function cachedImageUrl(path) {
        const cached = imageCache.get(String(path))
        return cached === undefined ? undefined : { phase: 'ready', url: cached }
      }

      /** Cached `/link` answer. */
      function cachedLink(url) {
        const cached = linkCache.get(String(url))
        return cached === undefined ? undefined : cached
      }

      /**
       * Synchronous peek state from the caches, so reopening a hover card paints
       * instantly (the async loader still refreshes it).
       * @param descriptor - hovered target.
       * @param mode - `peek` or `full`.
       * @returns a ready peek state, or undefined when the meta is not cached.
       */
      function cachedPeek(descriptor, mode) {
        try {
          const cached = cachedMeta(descriptor)
          if (cached === undefined || cached.phase !== 'ready' || cached.meta === null || cached.meta === undefined) return cached
          const meta = cached.meta
          const path = meta.absPath !== undefined ? meta.absPath : meta.relPath
          if (meta.preview === 'image') {
            const image = cachedImageUrl(path)
            return image === undefined ? cached : { phase: 'ready', meta: meta, image: image.url }
          }
          if (isTextPreview(meta.preview)) {
            const budget = mode === 'full' ? HOVER_FULL_TEXT_BYTES : HOVER_TEXT_BYTES
            const text = cachedText(path, budget)
            return text === undefined ? cached : { phase: 'ready', meta: meta, text: text.text, truncated: text.truncated }
          }
          return cached
        } catch (_error) {
          return undefined
        }
      }

      /** One hover-card read: metadata plus the inline body of the chosen mode. */
      async function loadPeek(descriptor, mode, signal) {
        const resolved = await resolveDescriptor(descriptor, signal)
        if (resolved.phase !== 'ready') return resolved
        const meta = resolved.meta
        if (meta === null) {
          // blob:/data:/http(s) image: no host metadata, the bytes are the card.
          return { phase: 'ready', meta: null, image: resolved.remote !== undefined ? resolved.remote.src : undefined }
        }
        const preview = meta.preview
        if (preview === 'image') {
          if (Number.isFinite(meta.size) && meta.size > HOVER_IMAGE_MAX_BYTES) {
            return { phase: 'ready', meta: meta, tooLarge: true }
          }
          const image = await imageUrlFor(meta.absPath !== undefined ? meta.absPath : meta.relPath, signal)
          if (image.phase === 'aborted') return image
          return image.phase === 'ready' ? { phase: 'ready', meta: meta, image: image.url } : { phase: 'ready', meta: meta, failed: true }
        }
        if (isTextPreview(preview)) {
          const budget = mode === 'full' ? HOVER_FULL_TEXT_BYTES : HOVER_TEXT_BYTES
          const text = await fetchText(meta.absPath !== undefined ? meta.absPath : meta.relPath, budget, signal)
          if (text.phase === 'aborted') return text
          if (text.phase !== 'ready') return { phase: 'ready', meta: meta, failed: true }
          return { phase: 'ready', meta: meta, text: text.text, truncated: text.truncated }
        }
        if (mode === 'full' && preview === 'pdf') {
          if (Number.isFinite(meta.size) && meta.size > HOVER_PDF_MAX_BYTES) return { phase: 'ready', meta: meta, tooLarge: true }
          const raw = await fetchRawBlob(meta.absPath !== undefined ? meta.absPath : meta.relPath, signal)
          if (raw.phase === 'aborted') return raw
          if (raw.phase !== 'ready') return { phase: 'ready', meta: meta, failed: true }
          let url
          try {
            url = URL.createObjectURL(new Blob([raw.blob], { type: 'application/pdf' }))
          } catch (_error) {
            return { phase: 'ready', meta: meta, failed: true }
          }
          return { phase: 'ready', meta: meta, frame: url }
        }
        return { phase: 'ready', meta: meta }
      }

      /** Copy text through the async clipboard, with an in-root legacy fallback. */
      async function copyText(text) {
        const value = String(text === undefined || text === null ? '' : text)
        if (value === '') return false
        try {
          if (navigator.clipboard !== undefined && navigator.clipboard !== null && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(value)
            return true
          }
        } catch (_error) {
          /* fall through to the legacy path */
        }
        try {
          if (rootEl === null) return false
          const area = document.createElement('textarea')
          area.value = value
          area.setAttribute('readonly', '')
          area.style.position = 'fixed'
          area.style.opacity = '0'
          area.style.pointerEvents = 'none'
          rootEl.appendChild(area)
          area.select()
          const ok = document.execCommand('copy')
          area.remove()
          return ok === true
        } catch (_error) {
          return false
        }
      }

      /** Re-encode any bitmap into PNG, which is what the clipboard accepts. */
      async function toPngBlob(blob) {
        try {
          if (typeof createImageBitmap !== 'function') return null
          const bitmap = await createImageBitmap(blob)
          const canvas = document.createElement('canvas')
          canvas.width = bitmap.width
          canvas.height = bitmap.height
          const context = canvas.getContext('2d')
          if (context === null) return null
          context.drawImage(bitmap, 0, 0)
          if (typeof bitmap.close === 'function') bitmap.close()
          return await new Promise(function (resolve) {
            canvas.toBlob(function (png) {
              resolve(png)
            }, 'image/png')
          })
        } catch (_error) {
          return null
        }
      }

      /** Copy an image as a real bitmap (`ClipboardItem`). */
      async function copyImageTarget(target) {
        let blob = null
        if (typeof target.path === 'string' && target.path !== '') {
          const raw = await fetchRawBlob(target.path)
          if (raw.phase === 'ready') blob = raw.blob
        } else if (typeof target.src === 'string' && target.src !== '') {
          try {
            const response = await fetch(target.src)
            if (response.ok) blob = await response.blob()
          } catch (_error) {
            blob = null
          }
        }
        if (blob === null) return { ok: false, tone: 'error', toast: 'action.failedCopy' }
        const png = await toPngBlob(blob)
        if (png === null) return { ok: false, tone: 'error', toast: 'action.imageCopyUnsupported' }
        if (
          typeof ClipboardItem === 'undefined' ||
          navigator.clipboard === undefined ||
          navigator.clipboard === null ||
          typeof navigator.clipboard.write !== 'function'
        ) {
          return { ok: false, tone: 'error', toast: 'action.failedCopy' }
        }
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
          return { ok: true, tone: 'ok', toast: 'toast.copiedImage' }
        } catch (_error) {
          return { ok: false, tone: 'error', toast: 'action.failedCopy' }
        }
      }

      /** POST one native action to the host half. */
      async function postAction(action, payload) {
        try {
          const response = await fetch(apiUrl('action'), {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(Object.assign({ action: action, seat: seat }, payload))
          })
          let body = null
          try {
            body = await response.json()
          } catch (_error) {
            body = null
          }
          return { status: response.status, ok: body !== null && typeof body === 'object' && body.ok === true, body: body }
        } catch (_error) {
          return { status: 0, ok: false, body: null }
        }
      }

      /** Fallback for open/reveal through the Session Remote (workspace paths). */
      async function openViaRemote(path, action) {
        try {
          const remote = ctx.remote
          if (remote === null || remote === undefined) return false
          const session = remote.session
          if (session === null || session === undefined || typeof session.openWorkspacePath !== 'function') return false
          const request = action === 'reveal' ? { path: path, action: 'reveal' } : { path: path }
          const answer = await session.openWorkspacePath(request)
          return answer !== null && answer !== undefined && answer.ok === true
        } catch (_error) {
          return false
        }
      }

      /** Full contents of a text file for the copy action. */
      async function textForCopy(path) {
        const cached = textCache.get(String(path) + '#' + String(TEXT_MAX_BYTES))
        if (cached !== undefined && cached.phase === 'ready') return cached.text
        const fresh = await fetchText(path, TEXT_MAX_BYTES)
        return fresh.phase === 'ready' ? fresh.text : ''
      }

      /**
       * Run one footer action.
       * @param action - `copy-path|copy-text|copy-image|copy-link|browser|reveal|open`.
       * @param target - what the overlay currently shows.
       * @returns `{ok, tone:'ok'|'error', toast}` where toast is a dictionary key.
       */
      async function perform(action, target) {
        try {
          if (target === null || target === undefined) return { ok: false, tone: 'error', toast: 'action.noTarget' }
          if (action === 'copy-path') {
            const value =
              typeof target.displayPath === 'string' && target.displayPath !== ''
                ? target.displayPath
                : typeof target.path === 'string'
                  ? target.path
                  : ''
            if (value === '') return { ok: false, tone: 'error', toast: 'action.noPath' }
            const copied = await copyText(value)
            return copied
              ? { ok: true, tone: 'ok', toast: 'toast.copiedPath' }
              : { ok: false, tone: 'error', toast: 'action.failedCopy' }
          }
          if (action === 'copy-text') {
            const value = typeof target.path === 'string' && target.path !== '' ? await textForCopy(target.path) : ''
            if (value === '') return { ok: false, tone: 'error', toast: 'action.failedCopy' }
            const copied = await copyText(value)
            return copied
              ? { ok: true, tone: 'ok', toast: 'toast.copiedText' }
              : { ok: false, tone: 'error', toast: 'action.failedCopy' }
          }
          if (action === 'copy-image') return await copyImageTarget(target)
          if (action === 'copy-contents') {
            // Text for text/markdown/code, the bitmap for images; anything else
            // has no copyable contents (the menu disables it with a reason).
            if (target.meta !== undefined && target.meta !== null) {
              if (target.meta.preview === 'image') return await copyImageTarget(target)
              if (!isTextPreview(target.meta.preview)) {
                return { ok: false, tone: 'error', toast: 'copy.contentsUnavailable' }
              }
            } else if (typeof target.src === 'string' && target.src !== '') {
              return await copyImageTarget(target)
            }
            const value = typeof target.path === 'string' && target.path !== '' ? await textForCopy(target.path) : ''
            if (value === '') return { ok: false, tone: 'error', toast: 'copy.contentsUnavailable' }
            const copied = await copyText(value)
            return copied
              ? { ok: true, tone: 'ok', toast: 'toast.copiedText' }
              : { ok: false, tone: 'error', toast: 'action.failedCopy' }
          }
          if (action === 'copy-file') {
            if (typeof target.path !== 'string' || target.path === '' || isAbsolutePath(target.path) !== true) {
              return { ok: false, tone: 'error', toast: 'action.noPath' }
            }
            /** Map a copy-file host answer to the toast the user sees. */
            const copyFileFailure = function (reply) {
              const code = reply.body !== null && reply.body !== undefined && typeof reply.body.code === 'string' ? reply.body.code : ''
              // A host that does not know the action yet explains itself in the UI.
              if (code === 'action-unavailable' || code === 'bad-request' || reply.status === 501 || reply.status === 400 || reply.status === 404) {
                return { ok: false, tone: 'error', toast: 'copy.fileUnavailable' }
              }
              return { ok: false, tone: 'error', toast: 'copy.fileFailed' }
            }
            const answer = await postAction('copy-file', { path: target.path })
            if (answer.ok) return { ok: true, tone: 'ok', toast: 'toast.copiedFile' }
            // The first cold start may exceed the host's launcher budget once;
            // that is a slow success, not a failure: retry exactly once.
            const code = answer.body !== null && answer.body !== undefined && typeof answer.body.code === 'string' ? answer.body.code : ''
            const message = answer.body !== null && answer.body !== undefined && typeof answer.body.message === 'string' ? answer.body.message : ''
            if (code === 'copy-file-failed' && /time(?:d|s)?[\s-]*out|timeout/i.test(message)) {
              await new Promise(function (resolve) {
                window.setTimeout(resolve, COPY_FILE_RETRY_MS)
              })
              const retried = await postAction('copy-file', { path: target.path })
              if (retried.ok) return { ok: true, tone: 'ok', toast: 'toast.copiedFile' }
              return copyFileFailure(retried)
            }
            return copyFileFailure(answer)
          }
          if (action === 'copy-link') {
            if (typeof target.url !== 'string' || target.url === '') return { ok: false, tone: 'error', toast: 'action.noTarget' }
            const copied = await copyText(target.url)
            return copied
              ? { ok: true, tone: 'ok', toast: 'toast.copiedLink' }
              : { ok: false, tone: 'error', toast: 'action.failedCopy' }
          }
          if (action === 'browser') {
            if (typeof target.url === 'string' && target.url !== '') {
              window.open(target.url, '_blank', 'noopener,noreferrer')
              return { ok: true, tone: 'ok', toast: 'toast.browserOpened' }
            }
            if (typeof target.path !== 'string' || target.path === '') return { ok: false, tone: 'error', toast: 'action.noPath' }
            const answer = await postAction('browser', { path: target.path })
            if (answer.ok) return { ok: true, tone: 'ok', toast: 'toast.browserOpened' }
            try {
              window.open(apiUrl('raw', { path: target.path, seat: seat }), '_blank', 'noopener,noreferrer')
              return { ok: true, tone: 'ok', toast: 'toast.browserOpened' }
            } catch (_error) {
              return { ok: false, tone: 'error', toast: 'action.failedBrowser' }
            }
          }
          if (action === 'reveal' || action === 'open') {
            if (typeof target.path !== 'string' || target.path === '') return { ok: false, tone: 'error', toast: 'action.noPath' }
            const answer = await postAction(action, { path: target.path })
            if (answer.ok) {
              return { ok: true, tone: 'ok', toast: action === 'reveal' ? 'toast.revealed' : 'toast.opened' }
            }
            if (await openViaRemote(target.path, action)) {
              return { ok: true, tone: 'ok', toast: action === 'reveal' ? 'toast.revealed' : 'toast.opened' }
            }
            return {
              ok: false,
              tone: 'error',
              toast: action === 'reveal' ? 'action.failedReveal' : 'action.failedOpen'
            }
          }
          return { ok: false, tone: 'error', toast: 'toast.failed' }
        } catch (_error) {
          return { ok: false, tone: 'error', toast: 'toast.failed' }
        }
      }

      //#region Hover controller
      /** Cancel every hover timer (open, close grace, watchdog) and the poll. */
      function clearHoverTimers() {
        if (hover.timer !== 0) {
          window.clearTimeout(hover.timer)
          hover.timer = 0
        }
        if (hover.grace !== 0) {
          window.clearTimeout(hover.grace)
          hover.grace = 0
        }
        if (hover.watchdog !== 0) {
          window.clearTimeout(hover.watchdog)
          hover.watchdog = 0
        }
        stopPoll()
      }

      /** Cancel the pending open timer only. */
      function cancelSchedule() {
        if (hover.timer !== 0) {
          window.clearTimeout(hover.timer)
          hover.timer = 0
        }
      }

      /** Cancel the pending close timer only. */
      function cancelGrace() {
        if (hover.grace !== 0) {
          window.clearTimeout(hover.grace)
          hover.grace = 0
        }
      }

      /** Cancel the fade-out timers only (the visual fade and its hard net). */
      function cancelFade() {
        if (hover.fade !== 0) {
          window.clearTimeout(hover.fade)
          hover.fade = 0
        }
        if (hover.fadeHard !== 0) {
          window.clearTimeout(hover.fadeHard)
          hover.fadeHard = 0
        }
      }

      /** Cancel the geometry watchdog. */
      function cancelWatchdog() {
        if (hover.watchdog !== 0) {
          window.clearTimeout(hover.watchdog)
          hover.watchdog = 0
        }
      }

      /** Stop the pointer-target poll (the card is closed). */
      function stopPoll() {
        if (hover.poll !== 0) {
          window.clearInterval(hover.poll)
          hover.poll = 0
        }
        hover.pollMisses = 0
      }

      /** Start the pointer-target poll while the card is open. */
      function startPoll() {
        hover.pollMisses = 0
        if (hover.poll !== 0) return
        hover.poll = window.setInterval(pollHover, PEEK_POLL_MS)
      }

      /** `true` when the element belongs to the hovered anchor or to the card. */
      function pointerRelatedToHover(element) {
        if (isElement(element) !== true) return false
        if (hover.anchor !== null && (element === hover.anchor || hover.anchor.contains(element))) return true
        if (popoverEl !== null && (element === popoverEl || popoverEl.contains(element))) return true
        return false
      }

      /** What the pointer is actually over right now, or null when unknowable. */
      function elementUnderPointer() {
        try {
          if (hover.hasPoint !== true) return undefined
          if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return undefined
          return document.elementFromPoint(hover.lastX, hover.lastY)
        } catch (_error) {
          return undefined
        }
      }

      /**
       * Poll tick: dismiss once the point has been over something unrelated for
       * two consecutive ticks. Catches the stationary-pointer case (the anchor
       * was re-rendered away without a pointer event).
       */
      function pollHover() {
        try {
          if (peekStore.get() === null) {
            stopPoll()
            return
          }
          const under = elementUnderPointer()
          if (under === undefined) return
          if (pointerRelatedToHover(under) || overHoverTargets(hover.lastX, hover.lastY)) {
            hover.pollMisses = 0
            return
          }
          hover.pollMisses += 1
          if (hover.pollMisses >= PEEK_POLL_MISSES) dismissPeek('poll')
        } catch (_error) {
          /* ignore */
        }
      }

      /** Whether an open copy menu owns the Escape key (see the key handlers). */
      function setMenuOpen(next) {
        menuOpen = next === true
      }

      /** `true` while a copy menu is open. */
      function isMenuOpen() {
        return menuOpen
      }

      /** Rect of one element, or null when it cannot be measured. */
      function rectOf(element) {
        try {
          if (element === null || element === undefined || typeof element.getBoundingClientRect !== 'function') return null
          const rect = element.getBoundingClientRect()
          return rect !== null && typeof rect === 'object' ? rect : null
        } catch (_error) {
          return null
        }
      }

      /** `true` when a viewport point falls inside a rect (with slack). */
      function pointInside(rect, x, y) {
        if (rect === null) return false
        return x >= rect.left - WATCHDOG_SLACK && x <= rect.right + WATCHDOG_SLACK && y >= rect.top - WATCHDOG_SLACK && y <= rect.bottom + WATCHDOG_SLACK
      }

      /** `true` when the point is over the hovered anchor or the card itself. */
      function overHoverTargets(x, y) {
        return pointInside(rectOf(hover.anchor), x, y) || pointInside(rectOf(popoverEl), x, y)
      }

      /** Arm the watchdog once; it fires even if no further pointer event arrives. */
      function armWatchdog() {
        if (hover.watchdog !== 0) return
        hover.watchdog = window.setTimeout(function () {
          hover.watchdog = 0
          if (peekStore.get() === null) return
          // The pointer may have come back without an event we observed.
          if (overHoverTargets(hover.lastX, hover.lastY)) return
          dismissPeek('watchdog')
        }, PEEK_WATCHDOG_MS)
      }

      /** Keep the card open while the pointer travels into it. */
      function keepPeek() {
        cancelGrace()
        cancelSchedule()
        cancelWatchdog()
        hover.pollMisses = 0
      }

      /**
       * Guarantee that the store ends at `null` after a dismissal.
       * Two independent timers are always scheduled together: cancelling one
       * (for a reopen) also cancels the other, so a dismissal can never leave a
       * non-null store without a pending null.
       */
      function schedulePeekFinalizer() {
        if (hover.fade !== 0) {
          window.clearTimeout(hover.fade)
          hover.fade = 0
        }
        if (hover.fadeHard !== 0) {
          window.clearTimeout(hover.fadeHard)
          hover.fadeHard = 0
        }
        hover.fade = window.setTimeout(function () {
          hover.fade = 0
          if (peekStore.get() !== null) peekStore.set(null)
          if (seat === 'peek') seat = 'mounted'
        }, PEEK_FADE_MS)
        // Hard net: even if the fade timer is cleared by a later call, this one
        // still nulls the store shortly after.
        hover.fadeHard = window.setTimeout(function () {
          hover.fadeHard = 0
          if (peekStore.get() !== null) peekStore.set(null)
          if (seat === 'peek') seat = 'mounted'
        }, PEEK_FADE_MS + 200)
      }

      /**
       * Close the hover card. Dismissal is idempotent and always ends at
       * `peekStore === null`: repeated calls re-schedule the finalizers instead
       * of cancelling them, and a cooldown suppresses the `pointerover` that the
       * browser fires when the card unmounts (the reopen loop seen live).
       * @param source - short identifier for diagnostics.
       * @param options - `{cooldown:false}` for incidental target changes.
       */
      function dismissPeek(source, options) {
        const reason = typeof source === 'string' && source !== '' ? source : 'unknown'
        debugState.dismiss += 1
        debugState.lastSource = reason
        if (options === undefined || options === null || options.cooldown !== false) {
          hover.suppressUntil = Date.now() + REOPEN_COOLDOWN_MS
        }
        cancelSchedule()
        cancelGrace()
        cancelWatchdog()
        stopPoll()
        menuOpen = false
        hover.key = ''
        hover.anchor = null
        const current = peekStore.get()
        if (current !== null && current.closing !== true) {
          peekStore.set(Object.assign({}, current, { closing: true }))
        }
        schedulePeekFinalizer()
      }

      /** Arm the grace-period close. */
      function armClose() {
        cancelGrace()
        hover.grace = window.setTimeout(function () {
          hover.grace = 0
          dismissPeek('leave')
        }, PEEK_GRACE_MS)
      }

      /** Hover targets are local files and local images only. */
      function classifyForPeek(element) {
        try {
          if (element === null || element === undefined) return null
          if (isElement(element) && element.closest('[data-changed-files]') !== null) return null
          const descriptor = classifyTarget(element)
          if (descriptor === null) return null
          if (descriptor.kind === 'web') return null
          if (descriptor.kind === 'file' && (typeof descriptor.path !== 'string' || descriptor.path === '')) return null
          if (descriptor.kind === 'image-src') return null
          // The shipped markdown hover card already previews linked images; a
          // second card on the same anchor would fight it.
          if (descriptor.origin === 'link' && isImageExtension(descriptor.path)) return null
          return descriptor
        } catch (_error) {
          return null
        }
      }

      /** Arm the hover timer for one target. */
      function schedulePeek(element) {
        if (hover.mode === 'off') {
          dismissPeek('mode-off')
          return
        }
        // A dismissal suppresses the pointerover the browser fires right after
        // the card unmounts; without this the card reopens immediately.
        if (Date.now() < hover.suppressUntil) return
        const descriptor = classifyForPeek(element)
        if (descriptor === null) {
          // Incidental target change (sweeping the chat): close, but do not arm
          // the reopen cooldown, or the next file would be ignored.
          dismissPeek('other-target', { cooldown: false })
          return
        }
        const key = descriptorKey(descriptor)
        if (hover.key === key && (hover.timer !== 0 || peekStore.get() !== null)) {
          keepPeek()
          return
        }
        cancelSchedule()
        cancelGrace()
        cancelWatchdog()
        hover.key = key
        hover.anchor = element
        const delay = hover.mode === 'full' ? FULL_DELAY_MS : PEEK_DELAY_MS
        hover.timer = window.setTimeout(function () {
          hover.timer = 0
          showPeek(descriptor, element)
        }, delay)
      }

      /** Publish the hover card state (one card, one request chain). */
      function showPeek(descriptor, element) {
        if (hover.mode === 'off' || disposed) return
        if (Date.now() < hover.suppressUntil) return
        if (overlayStore.get() !== null) return
        if (element !== null && element !== undefined && element.isConnected === false) return
        const rect = element !== null && element !== undefined && typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null
        if (rect === null || rect.width <= 0 || rect.height <= 0) return
        cancelFade()
        seat = 'peek'
        hover.nonce += 1
        debugState.open += 1
        peekStore.set({
          key: descriptorKey(descriptor),
          nonce: hover.nonce,
          mode: hover.mode,
          descriptor: descriptor,
          rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          closing: false
        })
        startPoll()
      }

      /** Switch the hover mode and persist it. */
      function setHoverMode(next) {
        if (PEEK_MODES.indexOf(next) === -1) return
        hover.mode = next
        writeHoverMode(next)
        modeStore.set(next)
        if (next === 'off') {
          dismissPeek('mode-off')
          return
        }
        const current = peekStore.get()
        if (current !== null) {
          hover.nonce += 1
          peekStore.set(Object.assign({}, current, { mode: next, nonce: hover.nonce }))
        }
      }

      /** Open the full preview and close the hover card. */
      function openPreview(descriptor, sourceEl) {
        try {
          if (descriptor === null || descriptor === undefined) return
          dismissPeek('open-preview')
          openToken += 1
          seat = 'modal'
          overlayStore.set(
            Object.assign({}, descriptor, {
              cwd: typeof descriptor.cwd === 'string' && descriptor.cwd !== '' ? descriptor.cwd : sessionCwd(),
              sourceEl: sourceEl !== null && sourceEl !== undefined ? sourceEl : descriptor.sourceEl !== undefined ? descriptor.sourceEl : null,
              token: openToken
            })
          )
        } catch (_error) {
          /* never throw into the click path */
        }
      }

      /** Close the full preview. */
      function closePreview() {
        try {
          overlayStore.set(null)
          seat = peekStore.get() !== null ? 'peek' : 'mounted'
        } catch (_error) {
          /* ignore */
        }
      }

      /** Capture-phase click interception. */
      function onClickCapture(event) {
        try {
          if (event.defaultPrevented) return
          if (event.button !== 0) return
          if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
          const path = typeof event.composedPath === 'function' ? event.composedPath() : []
          if (rootEl !== null && path.indexOf(rootEl) !== -1) return
          const descriptor = classifyTarget(event.target)
          if (descriptor === null) return
          event.preventDefault()
          event.stopPropagation()
          openPreview(descriptor, descriptor.sourceEl || event.target)
        } catch (_error) {
          /* the application keeps its own handling */
        }
      }

      /** Middle/right click: native handling stays untouched. */
      function onAuxClick(event) {
        try {
          if (event.button === 1 || event.button === 2) dismissPeek('auxclick')
        } catch (_error) {
          /* ignore */
        }
      }

      /** Pointer moving over the chat: schedule at most one hover card. */
      function onPointerOver(event) {
        try {
          if (event.pointerType === 'touch') return
          const path = typeof event.composedPath === 'function' ? event.composedPath() : []
          if (rootEl !== null && path.indexOf(rootEl) !== -1) {
            if (popoverEl !== null && path.indexOf(popoverEl) !== -1) keepPeek()
            return
          }
          if (overlayStore.get() !== null) return
          if (!isElement(event.target)) return
          schedulePeek(event.target)
        } catch (_error) {
          /* ignore */
        }
      }

      /** Pointer leaving an anchor or the card: arm the grace close. */
      function onPointerOut(event) {
        try {
          const related = event.relatedTarget
          if (related === null || related === undefined) {
            if (peekStore.get() !== null) armClose()
            return
          }
          if (isElement(related)) {
            if (popoverEl !== null && (related === popoverEl || popoverEl.contains(related))) {
              keepPeek()
              return
            }
            if (hover.anchor !== null && (related === hover.anchor || hover.anchor.contains(related))) return
          }
          if (peekStore.get() !== null) armClose()
        } catch (_error) {
          /* ignore */
        }
      }

      /**
       * A press outside the card dismisses it; the click then opens the modal.
       * A press inside the card belongs to its quick actions, so it must not
       * dismiss: a closing card is `pointer-events:none`, so the following click
       * would miss the button and fall through to the content behind the card.
       * The check is made on the event path (and `closest`), never hit-testing.
       */
      function onPointerDown(event) {
        try {
          if (event !== null && event !== undefined && popoverEl !== null) {
            const path = typeof event.composedPath === 'function' ? event.composedPath() : []
            if (path.indexOf(popoverEl) !== -1) return
            const target = event.target
            if (isElement(target) && (target === popoverEl || popoverEl.contains(target))) return
          }
          dismissPeek('pointerdown')
        } catch (_error) {
          /* ignore */
        }
      }

      /** Keyboard focus opens the same peek after the same delay. */
      function onFocusIn(event) {
        try {
          if (hover.mode === 'off' || overlayStore.get() !== null) return
          const target = event.target
          if (!isElement(target)) return
          if (rootEl !== null && rootEl.contains(target)) return
          if (target.closest('input, textarea, select, [contenteditable="true"]') !== null) return
          schedulePeek(target)
        } catch (_error) {
          /* ignore */
        }
      }

      /**
       * Scrolling the chat moves the anchor away: close at once. Scrolling
       * inside the card (its text body or a document frame) belongs to the card.
       */
      function onScroll(event) {
        try {
          if (event !== null && event !== undefined && popoverEl !== null) {
            const path = typeof event.composedPath === 'function' ? event.composedPath() : []
            if (path.indexOf(popoverEl) !== -1) return
            const target = event.target
            if (isElement(target) && (target === popoverEl || popoverEl.contains(target))) return
          }
          if (peekStore.get() !== null || hover.timer !== 0) dismissPeek('scroll')
        } catch (_error) {
          /* ignore */
        }
      }

      /**
       * Pointer motion is the primary dismissal signal: a move whose target is
       * neither the hovered anchor nor the card means the user left, even when
       * no `pointerout`/`relatedTarget` ever arrives. It also feeds the geometry
       * watchdog (second net) and the point used by the target poll.
       */
      function onPointerMove(event) {
        try {
          if (event === null || event === undefined) return
          if (event.pointerType === 'touch') return
          const x = Number(event.clientX)
          const y = Number(event.clientY)
          if (!Number.isFinite(x) || !Number.isFinite(y)) return
          hover.lastX = x
          hover.lastY = y
          hover.hasPoint = true
          if (peekStore.get() === null) {
            cancelWatchdog()
            cancelGrace()
            return
          }
          if (pointerRelatedToHover(event.target) === false) {
            // Over anything else: arm the short close grace.
            armClose()
          } else {
            cancelGrace()
          }
          if (overHoverTargets(x, y)) {
            cancelWatchdog()
            return
          }
          armWatchdog()
        } catch (_error) {
          /* ignore */
        }
      }

      /**
       * Wheel anywhere outside the card scrolls the chat away from the anchor:
       * dismiss. Wheel inside the card belongs to its own scroller.
       */
      function onWheel(event) {
        try {
          if (peekStore.get() === null) return
          if (event !== null && event !== undefined && popoverEl !== null) {
            const path = typeof event.composedPath === 'function' ? event.composedPath() : []
            if (path.indexOf(popoverEl) !== -1) return
            const target = event.target
            if (isElement(target) && (target === popoverEl || popoverEl.contains(target))) return
          }
          dismissPeek('wheel')
        } catch (_error) {
          /* ignore */
        }
      }

      /** Switching windows abandons the card; no pointerout arrives for it. */
      function onWindowBlur() {
        try {
          cancelWatchdog()
          dismissPeek('blur')
        } catch (_error) {
          /* ignore */
        }
      }

      /** The pointer left the document entirely (relatedTarget may be null). */
      function onDocumentMouseLeave() {
        try {
          cancelWatchdog()
          dismissPeek('document-leave')
        } catch (_error) {
          /* ignore */
        }
      }

      /** Escape closes the hover card without disturbing the app. */
      function onHoverKeyDown(event) {
        try {
          if (event.key !== 'Escape') return
          // An open copy menu owns Escape; its own handler closes the menu.
          if (isMenuOpen() === true) return
          if (peekStore.get() === null) return
          dismissPeek('escape')
        } catch (_error) {
          /* ignore */
        }
      }

      /** Resize or navigation invalidates the anchor position. */
      function onResize() {
        try {
          dismissPeek('resize')
        } catch (_error) {
          /* ignore */
        }
      }

      /** SPA navigation (and hash jumps) dismiss the card. */
      function onRouteChange() {
        try {
          dismissPeek('route')
        } catch (_error) {
          /* ignore */
        }
      }

      /** The single, scoped cursor affordance (removed in one line on unload). */
      function installCursorRule() {
        try {
          if (typeof document === 'undefined' || document.head === null) return function () {}
          const style = document.createElement('style')
          style.setAttribute(CURSOR_ATTR, '')
          style.textContent =
            'img[src*="api/file?path="], [data-presented-file] > button[title], [data-message-attachments] span[title] { cursor: zoom-in; }'
          document.head.appendChild(style)
          return function () {
            style.remove()
          }
        } catch (_error) {
          return function () {}
        }
      }

      /** Record that the client half is mounted in this page. */
      async function boot() {
        try {
          await requestJson(apiUrl('status', { seat: 'mounted' }))
        } catch (_error) {
          /* the restart hint appears on the first real request */
        }
      }

      /** Release everything the runtime owns. */
      function dispose() {
        disposed = true
        clearHoverTimers()
        cancelFade()
        try {
          peekStore.set(null)
          overlayStore.set(null)
        } catch (_error) {
          /* ignore */
        }
        for (const url of Array.from(imageCache.values())) {
          try {
            URL.revokeObjectURL(url)
          } catch (_error) {
            /* ignore */
          }
        }
        imageCache.clear()
        textCache.clear()
        metaCache.clear()
        failureCache.clear()
        linkCache.clear()
        rootEl = null
        popoverEl = null
      }

      return {
        ctx: ctx,
        t: t,
        subscribeLocale: subscribeLocale,
        keyChip: keyChip,
        keyAria: keyAria,
        formatBytes: formatBytes,
        formatDate: formatDate,
        activeLocale: activeLocale,
        sessionCwd: sessionCwd,
        reducedMotion: reducedMotion,
        overlayStore: overlayStore,
        peekStore: peekStore,
        modeStore: modeStore,
        overlay: function () {
          return overlayStore.get()
        },
        peek: function () {
          return peekStore.get()
        },
        hoverMode: function () {
          return hover.mode
        },
        setHoverMode: setHoverMode,
        classifyTarget: classifyTarget,
        openPreview: openPreview,
        closePreview: closePreview,
        dismissPeek: dismissPeek,
        schedulePeek: schedulePeek,
        keepPeek: keepPeek,
        armClose: armClose,
        resolveDescriptor: resolveDescriptor,
        cachedMeta: cachedMeta,
        cachedText: cachedText,
        cachedImageUrl: cachedImageUrl,
        cachedLink: cachedLink,
        cachedPeek: cachedPeek,
        fetchText: fetchText,
        fetchRawBlob: fetchRawBlob,
        fetchLink: fetchLink,
        imageUrlFor: imageUrlFor,
        officePdfUrl: officePdfUrl,
        loadPeek: loadPeek,
        perform: perform,
        copyText: copyText,
        postAction: postAction,
        onClickCapture: onClickCapture,
        onAuxClick: onAuxClick,
        onPointerOver: onPointerOver,
        onPointerOut: onPointerOut,
        onPointerMove: onPointerMove,
        onPointerDown: onPointerDown,
        onFocusIn: onFocusIn,
        onScroll: onScroll,
        onWheel: onWheel,
        onWindowBlur: onWindowBlur,
        onDocumentMouseLeave: onDocumentMouseLeave,
        onHoverKeyDown: onHoverKeyDown,
        onResize: onResize,
        onRouteChange: onRouteChange,
        installCursorRule: installCursorRule,
        boot: boot,
        dispose: dispose,
        setRoot: function (element) {
          rootEl = element
        },
        getRoot: function () {
          return rootEl
        },
        setPopover: function (element) {
          popoverEl = element
        },
        getPopover: function () {
          return popoverEl
        },
        /** Diagnostic view of the hover controller (used by the checks). */
        hoverState: function () {
          return {
            watchdogArmed: hover.watchdog !== 0,
            watchdogMs: PEEK_WATCHDOG_MS,
            graceArmed: hover.grace !== 0,
            openTimerArmed: hover.timer !== 0,
            anchorConnected: hover.anchor !== null && hover.anchor.isConnected !== false,
            polling: hover.poll !== 0,
            pollMs: PEEK_POLL_MS,
            pollMisses: hover.pollMisses,
            suppressForMs: Math.max(0, hover.suppressUntil - Date.now()),
            storeState: peekStore.get() === null ? 'null' : peekStore.get().closing === true ? 'closing' : 'open',
            fadePending: hover.fade !== 0 || hover.fadeHard !== 0
          }
        },
        /** Counters behind the gated hover diagnostics line. */
        debug: function () {
          return {
            open: debugState.open,
            dismiss: debugState.dismiss,
            lastSource: debugState.lastSource,
            storeState: peekStore.get() === null ? 'null' : peekStore.get().closing === true ? 'closing' : 'open',
            watchdogArmed: hover.watchdog !== 0,
            suppressForMs: Math.max(0, hover.suppressUntil - Date.now())
          }
        },
        /** `true` when `localStorage['dsh-file-preview.debug'] === '1'`. */
        debugEnabled: function () {
          try {
            return localStorage.getItem(DEBUG_KEY) === '1'
          } catch (_error) {
            return false
          }
        },
        setMenuOpen: setMenuOpen,
        isMenuOpen: isMenuOpen
      }
    }
    //#endregion

    /** Required client services; every one is used by this half. */
    const inject = ['slots', 'locale', 'shortcuts', 'sessions', 'remote', 'remote.session']

    /**
     * Install the interception, the hover controller and the overlay entry.
     * Every listener, timer and stylesheet created here is released by the
     * effect disposers, so unload and hot reload leave nothing behind.
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      const runtime = createRuntime(ctx)
      ctx.effect(function () {
        const disposers = []
        try {
          disposers.push(ctx.locale.register(NS, 'en', EN))
        } catch (_error) {
          /* another revision already owns (namespace, en) */
        }
        try {
          disposers.push(ctx.locale.register(NS, 'ru', RU))
        } catch (_error) {
          /* another revision already owns (namespace, ru) */
        }
        // The Russian language itself belongs to the language pack when one is
        // installed; only add it when the catalog has no `ru` (a bare profile),
        // so this plugin never fights the pack for the same definition.
        let hasRussian = false
        try {
          const snapshot = ctx.locale.getSnapshot()
          if (snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.locales)) {
            hasRussian = snapshot.locales.some(function (language) {
              return language !== null && language !== undefined && language.id === 'ru'
            })
          }
        } catch (_error) {
          /* an unreadable catalog keeps the pack in charge */
        }
        if (hasRussian !== true) {
          try {
            disposers.push(ctx.locale.addLanguage({ id: 'ru', label: RU['language.label'], fallback: 'en' }))
          } catch (_error) {
            /* the id is occupied after all */
          }
        }
        window.addEventListener('click', runtime.onClickCapture, true)
        window.addEventListener('auxclick', runtime.onAuxClick, { capture: true, passive: true })
        window.addEventListener('pointerover', runtime.onPointerOver, { capture: true, passive: true })
        window.addEventListener('pointerout', runtime.onPointerOut, { capture: true, passive: true })
        window.addEventListener('pointermove', runtime.onPointerMove, { capture: true, passive: true })
        window.addEventListener('pointerdown', runtime.onPointerDown, true)
        window.addEventListener('focusin', runtime.onFocusIn, true)
        window.addEventListener('scroll', runtime.onScroll, { capture: true, passive: true })
        window.addEventListener('wheel', runtime.onWheel, { capture: true, passive: true })
        window.addEventListener('keydown', runtime.onHoverKeyDown, true)
        window.addEventListener('resize', runtime.onResize, true)
        window.addEventListener('blur', runtime.onWindowBlur, true)
        window.addEventListener('popstate', runtime.onRouteChange, true)
        window.addEventListener('hashchange', runtime.onRouteChange, true)
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('mouseleave', runtime.onDocumentMouseLeave, true)
        }
        disposers.push(runtime.installCursorRule())
        runtime.boot()
        return function () {
          window.removeEventListener('click', runtime.onClickCapture, true)
          window.removeEventListener('auxclick', runtime.onAuxClick, { capture: true, passive: true })
          window.removeEventListener('pointerover', runtime.onPointerOver, { capture: true, passive: true })
          window.removeEventListener('pointerout', runtime.onPointerOut, { capture: true, passive: true })
          window.removeEventListener('pointermove', runtime.onPointerMove, { capture: true, passive: true })
          window.removeEventListener('pointerdown', runtime.onPointerDown, true)
          window.removeEventListener('focusin', runtime.onFocusIn, true)
          window.removeEventListener('scroll', runtime.onScroll, { capture: true, passive: true })
          window.removeEventListener('wheel', runtime.onWheel, { capture: true, passive: true })
          window.removeEventListener('keydown', runtime.onHoverKeyDown, true)
          window.removeEventListener('resize', runtime.onResize, true)
          window.removeEventListener('blur', runtime.onWindowBlur, true)
          window.removeEventListener('popstate', runtime.onRouteChange, true)
          window.removeEventListener('hashchange', runtime.onRouteChange, true)
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('mouseleave', runtime.onDocumentMouseLeave, true)
          }
          for (const dispose of disposers) {
            try {
              dispose()
            } catch (_error) {
              /* already released */
            }
          }
          runtime.dispose()
        }
      }, 'dsh-file-preview: window interception')

      ctx.effect(function () {
        return ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register(
            {
              name: 'shell.overlay',
              id: OVERLAY_ID,
              order: 40,
              label: function () {
                return runtime.t('entry.label')
              }
            },
            function () {
              return h(OverlaySeat, { runtime: runtime })
            }
          )
        })
      }, 'dsh-file-preview: overlay entry')
    }

    //#region Styles
    /**
     * Scoped stylesheet rendered inside the plugin's own root element.
     * Only theme tokens are used for colour; blur radii and geometry are local.
     */
    const CSS = `
.dfp-root{position:fixed;inset:0;z-index:1000;pointer-events:none;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:1.45;text-align:start}
.dfp-root *{box-sizing:border-box}
.dfp-modal-root{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto}
.dfp-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:blur(14px) saturate(120%);-webkit-backdrop-filter:blur(14px) saturate(120%);animation:dfp-fade-in 200ms var(--ds-ease-in-out)}
.dfp-panel{position:relative;display:flex;flex-direction:column;width:min(1200px,92vw);max-height:min(900px,88vh);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-panel);box-shadow:var(--dsw-elevation-prominent);overflow:hidden;outline:none;animation:dfp-panel-in 200ms var(--ds-ease-in-out)}
.dfp-panel:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-2px}
.dfp-panel-error{width:min(440px,92vw)}
@keyframes dfp-fade-in{from{opacity:0}to{opacity:1}}
@keyframes dfp-fade-out{from{opacity:1}to{opacity:0}}
@keyframes dfp-panel-in{from{opacity:0;transform:scale(.965) translateY(8px)}to{opacity:1;transform:none}}
@keyframes dfp-panel-out{from{opacity:1;transform:none}to{opacity:0;transform:scale(.985) translateY(4px)}}
.dfp-modal-root[data-closing="true"] .dfp-mask{animation:dfp-fade-out 140ms var(--ds-ease-in-out) forwards}
.dfp-modal-root[data-closing="true"] .dfp-panel{animation:dfp-panel-out 140ms var(--ds-ease-in-out) forwards}
.dfp-head{display:flex;align-items:flex-start;gap:12px;padding:16px 14px 14px 20px;border-bottom:1px solid var(--dsw-alias-border-l2);min-width:0}
.dfp-heading{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
.dfp-badge{display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:46px;max-width:96px;height:26px;padding:0 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font:600 11px/1 var(--dsw-font-family);letter-spacing:.05em;text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfp-title{margin:0;font:600 15px/1.3 var(--dsw-font-family);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dfp-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;overflow-wrap:anywhere}
.dfp-path{color:var(--dsw-alias-label-caption);font:11px/1.4 var(--ds-font-family-code);overflow-wrap:anywhere}
.dfp-head-tools{display:flex;align-items:center;gap:8px;flex:none}
.dfp-seg{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.dfp-seg-label{padding:0 6px;color:var(--dsw-alias-label-caption);font-size:11px}
.dfp-seg button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:500 11px/1 var(--dsw-font-family);padding:6px 8px;cursor:pointer}
.dfp-seg button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dfp-seg button[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
.dfp-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.dfp-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dfp-iconbtn:focus-visible,.dfp-action:focus-visible,.dfp-state-action:focus-visible,.dfp-tool:focus-visible,.dfp-peek-action:focus-visible,.dfp-link-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px}
.dfp-body{position:relative;flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.dfp-skeleton-wrap{display:flex;flex-direction:column;gap:12px;padding:24px}
.dfp-skeleton{height:14px;border-radius:var(--dsw-radius-sm);background:linear-gradient(90deg,var(--dsw-alias-bg-layer-1) 0%,var(--dsw-alias-interactive-bg-hover) 50%,var(--dsw-alias-bg-layer-1) 100%);background-size:220% 100%;animation:dfp-shimmer 1.4s linear infinite}
.dfp-skeleton-title{height:20px;width:38%}
.dfp-skeleton-line{width:100%}
.dfp-skeleton-line[data-short="true"]{width:62%}
.dfp-loading-label{padding:0 24px 20px;color:var(--dsw-alias-label-tertiary);font-size:12px}
@keyframes dfp-shimmer{from{background-position:120% 0}to{background-position:-120% 0}}
.dfp-state{display:flex;align-items:flex-start;gap:14px;padding:26px 24px;max-width:640px}
.dfp-state-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:34px;height:34px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-business-primary)}
.dfp-state[data-tone="error"] .dfp-state-icon{color:var(--dsw-alias-state-error-primary)}
.dfp-state-text{display:flex;flex-direction:column;gap:6px;min-width:0}
.dfp-state-title{font-weight:600;font-size:14px}
.dfp-state-body{color:var(--dsw-alias-label-secondary);font-size:12.5px;overflow-wrap:anywhere}
.dfp-state-line+.dfp-state-line{margin-top:4px}
.dfp-state-action{align-self:flex-start;appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:500 12px/1 var(--dsw-font-family);padding:8px 12px;cursor:pointer}
.dfp-state-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dfp-notice{display:flex;align-items:flex-start;gap:8px;margin:12px 20px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px}
.dfp-text{display:flex;flex-direction:column;min-height:0;flex:1 1 auto}
.dfp-toolbar{display:flex;align-items:center;gap:6px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.dfp-tool{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:500 11.5px/1 var(--dsw-font-family);padding:6px 9px;cursor:pointer}
.dfp-tool:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dfp-tool[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
.dfp-tool-meta{margin-inline-start:auto;color:var(--dsw-alias-label-caption);font-size:11px}
.dfp-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:12px 0}
.dfp-lines{font:12px/1.55 var(--ds-font-family-code);color:var(--dsw-alias-label-primary)}
.dfp-line{display:flex;gap:14px;padding:0 16px;white-space:pre}
.dfp-line:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dfp-ln{flex:none;width:44px;text-align:end;color:var(--dsw-alias-label-caption);user-select:none}
.dfp-lc{flex:1 1 auto;min-width:0;overflow-wrap:normal}
.dfp-lines-wrap .dfp-line{white-space:pre-wrap}
.dfp-lines-wrap .dfp-lc{white-space:pre-wrap;overflow-wrap:anywhere}
.dfp-pre{margin:0;padding:12px 16px;font:12px/1.55 var(--ds-font-family-code);white-space:pre;overflow:auto}
.dfp-pre-wrap{white-space:pre-wrap;overflow-wrap:anywhere}
.dfp-md{padding:16px 22px;max-width:820px;color:var(--dsw-alias-label-primary)}
.dfp-md h3,.dfp-md h4,.dfp-md h5,.dfp-md h6{margin:18px 0 8px;font-weight:600;line-height:1.3}
.dfp-md h3{font-size:17px}.dfp-md h4{font-size:15px}.dfp-md h5{font-size:13.5px}.dfp-md h6{font-size:13px}
.dfp-md-p{margin:0 0 10px;overflow-wrap:anywhere}
.dfp-md-list{margin:0 0 10px;padding-inline-start:22px}
.dfp-md-list li{margin:2px 0}
.dfp-md-quote{margin:0 0 10px;padding:2px 0 2px 12px;border-inline-start:3px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}
.dfp-md-hr{border:0;border-top:1px solid var(--dsw-alias-border-l2);margin:14px 0}
.dfp-md-code{margin:0 0 12px;padding:12px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);overflow:auto;font:12px/1.55 var(--ds-font-family-code)}
.dfp-md-inline-code{padding:1px 4px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);font:11.5px/1.4 var(--ds-font-family-code)}
.dfp-md-link{color:var(--dsw-alias-link);text-decoration:none}
.dfp-md-link:hover{text-decoration:underline}
.dfp-image{display:flex;flex-direction:column;min-height:0;flex:1 1 auto}
.dfp-image-toolbar{display:flex;align-items:center;gap:6px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dfp-zoom-label{margin-inline-start:auto;color:var(--dsw-alias-label-caption);font:11px/1 var(--ds-font-family-code)}
.dfp-image-stage{position:relative;flex:1 1 auto;min-height:0;height:min(620px,66vh);display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--dsw-alias-bg-layer-1);cursor:grab;touch-action:none}
.dfp-image-stage[data-dragging="true"]{cursor:grabbing}
.dfp-image-stage img{max-width:none;max-height:none;user-select:none;-webkit-user-drag:none;transform-origin:center center;will-change:transform}
.dfp-image-hint{position:absolute;inset-block-end:10px;inset-inline-start:50%;transform:translateX(-50%);padding:4px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font-size:11px;pointer-events:none;opacity:.85}
.dfp-doc{display:flex;flex-direction:column;min-height:0;flex:1 1 auto}
.dfp-doc-note{padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-caption);font-size:11.5px}
.dfp-frame{flex:1 1 auto;width:100%;min-height:0;height:min(680px,68vh);border:0;background:var(--dsw-alias-bg-base)}
.dfp-media-wrap{display:flex;align-items:center;justify-content:center;flex:1 1 auto;min-height:0;padding:20px;background:var(--dsw-alias-bg-layer-1)}
.dfp-media{max-width:100%;max-height:min(620px,66vh);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base)}
.dfp-audio{width:min(560px,100%)}
.dfp-filecard{display:flex;align-items:center;gap:18px;padding:28px 24px;flex-wrap:wrap}
.dfp-filecard-badge{display:inline-flex;align-items:center;justify-content:center;width:74px;height:74px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font:700 15px/1 var(--dsw-font-family);letter-spacing:.04em;text-transform:uppercase;flex:none;overflow:hidden}
.dfp-filecard-body{display:flex;flex-direction:column;gap:6px;min-width:0}
.dfp-filecard-name{font-weight:600;font-size:15px;overflow-wrap:anywhere}
.dfp-filecard-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;overflow-wrap:anywhere}
.dfp-filecard-path{color:var(--dsw-alias-label-caption);font:11px/1.4 var(--ds-font-family-code);overflow-wrap:anywhere}
.dfp-details{display:flex;flex-direction:column;min-height:0;flex:1 1 auto;overflow:auto;padding:20px 24px;gap:14px}
.dfp-details-row{display:flex;gap:14px;font-size:12.5px}
.dfp-details-key{flex:none;width:110px;color:var(--dsw-alias-label-tertiary)}
.dfp-details-value{min-width:0;overflow-wrap:anywhere;font-family:var(--ds-font-family-code);font-size:11.5px}
.dfp-web{display:flex;flex-direction:column;gap:0;flex:1 1 auto;min-height:0;overflow:auto}
.dfp-web-image{width:100%;max-height:min(340px,34vh);object-fit:cover;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dfp-web-body{display:flex;flex-direction:column;gap:10px;padding:22px 24px}
.dfp-web-head{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dfp-web-icon{width:18px;height:18px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);flex:none}
.dfp-web-title{margin:0;font:600 18px/1.35 var(--dsw-font-family);overflow-wrap:anywhere}
.dfp-web-desc{color:var(--dsw-alias-label-secondary);font-size:13px;overflow-wrap:anywhere}
.dfp-web-url{color:var(--dsw-alias-label-caption);font:11px/1.4 var(--ds-font-family-code);overflow-wrap:anywhere}
.dfp-link-btn{display:inline-flex;align-items:center;gap:9px;align-self:flex-start;appearance:none;border:1px solid var(--dsw-alias-state-business-primary);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-layer-2);font:600 13px/1 var(--dsw-font-family);padding:12px 18px;cursor:pointer;margin-top:6px}
.dfp-link-btn:hover{filter:brightness(1.06)}
.dfp-foot{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);flex-wrap:wrap}
.dfp-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dfp-action{display:inline-flex;align-items:center;gap:8px;appearance:none;height:34px;padding:0 10px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:500 12.5px/1 var(--dsw-font-family);cursor:pointer}
.dfp-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dfp-action:disabled{opacity:.45;cursor:not-allowed}
.dfp-kbd{font:500 10.5px/1 var(--ds-font-family-code);color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xs);padding:3px 5px;background:var(--dsw-alias-bg-base)}
.dfp-toast{position:absolute;inset-inline-start:50%;inset-block-end:64px;transform:translateX(-50%);padding:9px 14px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv3);font-size:12px;animation:dfp-rise 160ms var(--ds-ease-in-out)}
.dfp-toast[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
@keyframes dfp-rise{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}
.dfp-peek{position:fixed;z-index:100;pointer-events:auto;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary);overflow:hidden;font-family:var(--dsw-font-family);font-size:12px;line-height:1.45;animation:dfp-peek-in 120ms var(--ds-ease-in-out)}
.dfp-peek[data-closing="true"]{opacity:0;pointer-events:none;transition:opacity 100ms linear}
.dfp-peek-head{position:relative;display:flex;align-items:center;gap:9px;padding:10px 34px 10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0}
.dfp-peek-close{position:absolute;inset-block-start:6px;inset-inline-end:6px;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}
.dfp-peek-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dfp-peek-close:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-2px}
.dfp-peek-badge{display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:38px;max-width:72px;height:22px;padding:0 6px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font:600 10px/1 var(--dsw-font-family);letter-spacing:.05em;text-transform:uppercase;overflow:hidden}
.dfp-peek-heading{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}
.dfp-peek-name{font-weight:600;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfp-peek-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfp-peek-body{min-height:0;overflow:auto;background:var(--dsw-alias-bg-layer-2)}
.dfp-peek-media{display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-1);max-height:280px;overflow:hidden}
.dfp-peek-media img{max-width:100%;max-height:280px;display:block;object-fit:contain}
.dfp-peek-frame{width:100%;height:300px;border:0;background:var(--dsw-alias-bg-base)}
.dfp-peek-lines{padding:8px 0;font:11px/1.5 var(--ds-font-family-code)}
.dfp-peek-line{padding:0 12px;white-space:pre;overflow:hidden;text-overflow:ellipsis}
.dfp-peek-hint{padding:14px 12px;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.dfp-peek-more{display:block;width:100%;text-align:start;appearance:none;border:0;border-top:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-link);font:500 11.5px/1.45 var(--dsw-font-family);padding:8px 12px;cursor:pointer;overflow-wrap:anywhere}
.dfp-peek-more:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dfp-peek-more:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-2px}
.dfp-peek-debug{margin-inline-start:auto;color:var(--dsw-alias-label-caption);font:10px/1 var(--ds-font-family-code);opacity:.7;white-space:nowrap}
.dfp-peek-foot{display:flex;align-items:center;gap:4px;padding:6px 8px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dfp-peek-action{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.dfp-peek-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dfp-peek-action:disabled{opacity:.4;cursor:not-allowed}
.dfp-peek-flash{margin-inline-start:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;padding-inline-end:4px}
.dfp-split{position:relative;display:inline-flex;align-items:stretch}
.dfp-split .dfp-split-main{border-start-end-radius:0;border-end-end-radius:0}
.dfp-split-toggle{display:inline-flex;align-items:center;justify-content:center;height:34px;width:26px;appearance:none;border:1px solid var(--dsw-alias-border-l2);border-inline-start:0;border-start-end-radius:var(--dsw-radius-sm);border-end-end-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.dfp-split-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dfp-split-toggle:disabled{opacity:.45;cursor:not-allowed}
.dfp-split-toggle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px}
.dfp-split-compact{position:static;gap:2px}
.dfp-split-toggle-compact{display:inline-flex;align-items:center;justify-content:center;width:16px;height:26px;appearance:none;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}
.dfp-split-toggle-compact:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dfp-split-toggle-compact:disabled{opacity:.4;cursor:not-allowed}
.dfp-split-toggle-compact:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-2px}
.dfp-menu{position:absolute;z-index:6;inset-block-end:calc(100% + 6px);inset-inline-start:0;min-width:230px;display:flex;flex-direction:column;gap:2px;padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-panel)}
.dfp-split-compact .dfp-menu{inset-block-end:40px;inset-inline-start:auto;inset-inline-end:6px;min-width:210px;max-height:190px;overflow:auto}
.dfp-menu-item{display:flex;align-items:center;gap:8px;width:100%;appearance:none;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:500 12.5px/1.2 var(--dsw-font-family);padding:8px 10px;cursor:pointer;text-align:start}
.dfp-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dfp-menu-item:disabled{opacity:.55;cursor:not-allowed}
.dfp-menu-item:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-2px}
.dfp-menu-reason{margin-inline-start:auto;color:var(--dsw-alias-label-caption);font-size:10.5px;max-width:130px;text-align:end}
.dfp-empty{display:flex;flex-direction:column;gap:8px;padding:28px 24px;color:var(--dsw-alias-label-secondary)}
@keyframes dfp-peek-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion: reduce){
  .dfp-mask,.dfp-panel,.dfp-skeleton,.dfp-toast,.dfp-peek{animation:none!important}
  .dfp-modal-root[data-closing="true"] .dfp-mask,.dfp-modal-root[data-closing="true"] .dfp-panel{animation:none!important;opacity:1}
  .dfp-peek[data-closing="true"]{transition:none}
}
`
    //#endregion

    //#region Presentational atoms
    /** Hand-drawn 16x16 line icons: no Harness package, no icon font. */
    const ICONS = {
      close: 'M4 4 L12 12 M12 4 L4 12',
      copy: 'M10.5 5.5 v-1 a1 1 0 0 0 -1 -1 h-6 a1 1 0 0 0 -1 1 v6 a1 1 0 0 0 1 1 h1 M5.5 5.5 h6 a1 1 0 0 1 1 1 v6 a1 1 0 0 1 -1 1 h-6 a1 1 0 0 1 -1 -1 v-6 a1 1 0 0 1 1 -1 z',
      globe: 'M8 2 a6 6 0 1 0 0 12 a6 6 0 1 0 0 -12 M2 8 h12 M8 2 c2.2 2.4 2.2 9.6 0 12 M8 2 c-2.2 2.4 -2.2 9.6 0 12',
      folder: 'M2.5 4.5 a1 1 0 0 1 1 -1 h3 l1.5 1.5 h4.5 a1 1 0 0 1 1 1 v6 a1 1 0 0 1 -1 1 h-9 a1 1 0 0 1 -1 -1 z',
      open: 'M6.5 3.5 h-2 a1 1 0 0 0 -1 1 v8 a1 1 0 0 0 1 1 h8 a1 1 0 0 0 1 -1 v-2 M9 3 h4 v4 M13 3 L7.5 8.5',
      zoomIn: 'M7 2.5 a4.5 4.5 0 1 0 0 9 a4.5 4.5 0 1 0 0 -9 M10.5 10.5 L14 14 M4.75 7 h4.5 M7 4.75 v4.5',
      zoomOut: 'M7 2.5 a4.5 4.5 0 1 0 0 9 a4.5 4.5 0 1 0 0 -9 M10.5 10.5 L14 14 M4.75 7 h4.5',
      fit: 'M3 6 v-2 a1 1 0 0 1 1 -1 h2 M10 3 h2 a1 1 0 0 1 1 1 v2 M13 10 v2 a1 1 0 0 1 -1 1 h-2 M6 13 h-2 a1 1 0 0 1 -1 -1 v-2',
      chevron: 'M6 4 l4 4 l-4 4',
      file: 'M4.5 2.5 h4.5 l2.5 2.5 v8.5 h-7 z M9 2.5 v3 h3',
      actual: 'M2.5 2.5 h11 v11 h-11 z M5.5 5.5 h5 v5 h-5 z',
      wrap: 'M2.5 4 h11 M2.5 8 h6.5 a2.5 2.5 0 0 1 0 5 h-2 M8.5 11 l-1.8 2 l1.8 2',
      source: 'M5.5 4.5 L2 8 l3.5 3.5 M10.5 4.5 L14 8 l-3.5 3.5',
      check: 'M3 8.5 l3 3 l7 -7',
      alert: 'M8 2.5 L14.5 13.5 h-13 z M8 6.5 v3.5 M8 12 v.5',
      info: 'M8 2.5 a5.5 5.5 0 1 0 0 11 a5.5 5.5 0 1 0 0 -11 M8 7 v4 M8 5 v.5'
    }

    /**
     * One inline icon.
     * @param props - `{name, size}`.
     */
    function Icon(props) {
      const path = ICONS[props.name]
      if (path === undefined) return null
      const size = typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false'
        },
        h('path', { d: path })
      )
    }

    /** Loading skeleton with a localized caption. */
    function Skeleton(props) {
      return h(
        'div',
        { className: 'dfp-skeleton-wrap', 'aria-busy': 'true' },
        h('div', { className: 'dfp-skeleton dfp-skeleton-title' }),
        h('div', { className: 'dfp-skeleton dfp-skeleton-line' }),
        h('div', { className: 'dfp-skeleton dfp-skeleton-line' }),
        h('div', { className: 'dfp-skeleton dfp-skeleton-line', 'data-short': 'true' }),
        props.label === undefined ? null : h('div', { className: 'dfp-loading-label' }, props.label)
      )
    }

    /**
     * Inline state card: error, restart hint, or a plain notice.
     * `body` may be a string or an array of lines (failure code, path, hint).
     * @param props - `{tone, title, body, actionLabel, onAction}`.
     */
    function StateCard(props) {
      const lines =
        props.body === undefined ? [] : Array.isArray(props.body) ? props.body.filter((line) => line !== undefined && line !== null && line !== '') : [props.body]
      return h(
        'div',
        { className: 'dfp-state', 'data-tone': props.tone === undefined ? 'info' : props.tone },
        h('span', { className: 'dfp-state-icon' }, h(Icon, { name: props.tone === 'error' ? 'alert' : 'info' })),
        h(
          'div',
          { className: 'dfp-state-text' },
          h('div', { className: 'dfp-state-title' }, props.title),
          lines.length === 0
            ? null
            : h(
                'div',
                { className: 'dfp-state-body' },
                lines.map(function (line, index) {
                  return h('div', { key: 'ln' + String(index), className: 'dfp-state-line' }, line)
                })
              )
        ),
        props.onAction === undefined
          ? null
          : h('button', { type: 'button', className: 'dfp-state-action', onClick: props.onAction }, props.actionLabel)
      )
    }
    //#endregion

    //#region Async hook
    /**
     * Run one abortable read for a mounted view.
     * @param runtime - plugin runtime (part of the identity).
     * @param key - identity of the request; a change restarts it.
     * @param loader - `(signal) => Promise<state>`.
     * @param seed - optional synchronous cache read; a hit renders without a
     *   loading flash on reopen.
     * @returns `[state, retry]`.
     */
    function useAsyncResource(runtime, key, loader, seed) {
      const [state, setState] = React.useState(function () {
        const initial = typeof seed === 'function' ? seed() : undefined
        return initial === undefined || initial === null ? { phase: 'loading' } : initial
      })
      const [attempt, setAttempt] = React.useState(0)
      React.useEffect(
        function () {
          let live = true
          const controller = new AbortController()
          setState(function (currentState) {
            // A cache-seeded first render stays ready; an explicit retry loads.
            return attempt === 0 && currentState.phase === 'ready' ? currentState : { phase: 'loading' }
          })
          Promise.resolve()
            .then(function () {
              return loader(controller.signal)
            })
            .then(function (value) {
              if (!live) return
              setState(value !== null && value !== undefined ? value : { phase: 'error', code: 'unknown' })
            })
            .catch(function () {
              if (live && controller.signal.aborted !== true) setState({ phase: 'error', code: 'network' })
            })
          return function () {
            live = false
            controller.abort()
          }
        },
        [runtime, key, attempt]
      )
      return [
        state,
        function () {
          setAttempt(function (value) {
            return value + 1
          })
        }
      ]
    }
    //#endregion

    //#region Markdown
    /**
     * Tokenize one line of inline markdown into React nodes.
     * Raw HTML is never interpreted: text stays text, only http(s) links become
     * anchors.
     * @param value - inline source text.
     * @returns React children.
     */
    function inlineNodes(value) {
      const source = String(value)
      const pattern = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()]+)/g
      const nodes = []
      let last = 0
      let index = 0
      let match = pattern.exec(source)
      while (match !== null) {
        if (match.index > last) nodes.push(source.slice(last, match.index))
        if (match[2] !== undefined) {
          nodes.push(h('code', { key: 'in' + String(index), className: 'dfp-md-inline-code' }, match[2]))
        } else if (match[4] !== undefined) {
          nodes.push(h('strong', { key: 'in' + String(index) }, match[4]))
        } else if (match[6] !== undefined) {
          nodes.push(h('em', { key: 'in' + String(index) }, match[6]))
        } else if (match[8] !== undefined) {
          nodes.push(
            h(
              'a',
              {
                key: 'in' + String(index),
                className: 'dfp-md-link',
                href: match[9],
                target: '_blank',
                rel: 'noopener noreferrer'
              },
              match[8]
            )
          )
        } else if (match[10] !== undefined) {
          nodes.push(
            h(
              'a',
              {
                key: 'in' + String(index),
                className: 'dfp-md-link',
                href: match[10],
                target: '_blank',
                rel: 'noopener noreferrer'
              },
              match[10]
            )
          )
        }
        index += 1
        last = pattern.lastIndex
        match = pattern.exec(source)
      }
      if (last < source.length) nodes.push(source.slice(last))
      return nodes.length === 0 ? source : nodes
    }

    /**
     * Render a small, safe markdown subset (headings, lists, quotes, fences,
     * rules, paragraphs and inline emphasis/code/links).
     * @param value - markdown source.
     * @returns a React element.
     */
    function renderMarkdown(value) {
      // CRLF (Windows-authored notes) leaves a bare \r at every line end, which
      // hides headings, fences and rules from the line patterns below.
      const lines = String(value).replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      let paragraph = []
      const flush = function () {
        if (paragraph.length === 0) return
        blocks.push(h('p', { key: 'b' + String(blocks.length), className: 'dfp-md-p' }, inlineNodes(paragraph.join(' '))))
        paragraph = []
      }
      let index = 0
      while (index < lines.length) {
        const line = lines[index]
        if (/^```/.test(line)) {
          flush()
          const code = []
          index += 1
          while (index < lines.length && /^```/.test(lines[index]) === false) {
            code.push(lines[index])
            index += 1
          }
          index += 1
          blocks.push(
            h('pre', { key: 'b' + String(blocks.length), className: 'dfp-md-code' }, h('code', null, code.join('\n')))
          )
          continue
        }
        if (/^\s*$/.test(line)) {
          flush()
          index += 1
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          flush()
          const level = Math.min(6, heading[1].length)
          blocks.push(
            h(
              'h' + String(level + 2),
              { key: 'b' + String(blocks.length), className: 'dfp-md-h' },
              inlineNodes(heading[2])
            )
          )
          index += 1
          continue
        }
        if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
          flush()
          const items = []
          while (index < lines.length && /^\s*(?:[-*+]|\d+\.)\s+/.test(lines[index])) {
            items.push(
              h(
                'li',
                { key: 'l' + String(items.length) },
                inlineNodes(lines[index].replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''))
              )
            )
            index += 1
          }
          blocks.push(h('ul', { key: 'b' + String(blocks.length), className: 'dfp-md-list' }, items))
          continue
        }
        if (/^>\s?/.test(line)) {
          flush()
          blocks.push(
            h(
              'blockquote',
              { key: 'b' + String(blocks.length), className: 'dfp-md-quote' },
              inlineNodes(line.replace(/^>\s?/, ''))
            )
          )
          index += 1
          continue
        }
        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          flush()
          blocks.push(h('hr', { key: 'b' + String(blocks.length), className: 'dfp-md-hr' }))
          index += 1
          continue
        }
        paragraph.push(line.trim())
        index += 1
      }
      flush()
      return h('div', { className: 'dfp-md' }, blocks)
    }
    //#endregion

    //#region Views
    /** Text body with line numbers (per-line nodes only up to a cap). */
    function TextLines(props) {
      const lines = props.lines
      const wrapClass = props.wrap ? ' dfp-pre-wrap' : ''
      if (lines.length > MAX_TEXT_LINES) {
        return h('pre', { className: 'dfp-pre' + wrapClass }, props.text)
      }
      return h(
        'div',
        { className: 'dfp-lines' + (props.wrap ? ' dfp-lines-wrap' : '') },
        lines.map(function (line, index) {
          return h(
            'div',
            { className: 'dfp-line', key: 'line' + String(index) },
            h('span', { className: 'dfp-ln', 'aria-hidden': 'true' }, String(index + 1)),
            h('span', { className: 'dfp-lc' }, line === '' ? '\u00a0' : line)
          )
        })
      )
    }

    /** Text / code / markdown viewer with wrap and source toggles. */
    function TextPanel(props) {
      const runtime = props.runtime
      const t = useLocale(runtime)
      const markdown = props.markdown === true
      const [wrap, setWrap] = React.useState(false)
      const [source, setSource] = React.useState(false)
      const [text, retry] = useAsyncResource(
        runtime,
        'text:' + props.path,
        function (signal) {
          return runtime.fetchText(props.path, TEXT_MAX_BYTES, signal)
        },
        function () {
          return runtime.cachedText(props.path, TEXT_MAX_BYTES)
        }
      )
      if (text.phase === 'loading') return h(Skeleton, { label: t('state.loadingFile') })
      if (text.phase === 'aborted') return null
      if (text.phase === 'hostMissing') return restartView(t, retry)
      if (text.phase === 'error') {
        if (text.code === 'binary') {
          return h(FileCard, {
            runtime: runtime,
            meta: props.meta,
            title: t('state.binaryTitle'),
            notice: t('state.binaryBody')
          })
        }
        return errorView(t, text.code, retry, props.path)
      }
      const value = text.text
      if (value === '') {
        return h('div', { className: 'dfp-empty' }, t('viewer.empty'))
      }
      const lines = value.split('\n')
      const rendered = markdown && source !== true
      const meta = []
      if (text.truncated === true) meta.push(t('state.truncated', { size: runtime.formatBytes(TEXT_MAX_BYTES) }))
      if (typeof text.encoding === 'string' && text.encoding !== '') meta.push(t('state.encoding', { encoding: text.encoding }))
      return h(
        'div',
        { className: 'dfp-text' },
        h(
          'div',
          { className: 'dfp-toolbar' },
          h(
            'button',
            {
              type: 'button',
              className: 'dfp-tool',
              'aria-pressed': wrap ? 'true' : 'false',
              onClick: function () {
                setWrap(function (value2) {
                  return value2 !== true
                })
              },
              title: wrap ? t('viewer.nowrap') : t('viewer.wrap')
            },
            h(Icon, { name: 'wrap', size: 13 }),
            ' ',
            wrap ? t('viewer.nowrap') : t('viewer.wrap')
          ),
          markdown
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dfp-tool',
                  'aria-pressed': source ? 'true' : 'false',
                  onClick: function () {
                    setSource(function (value2) {
                      return value2 !== true
                    })
                  },
                  title: source ? t('viewer.rendered') : t('viewer.source')
                },
                h(Icon, { name: 'source', size: 13 }),
                ' ',
                source ? t('viewer.rendered') : t('viewer.source')
              )
            : null,
          h('span', { className: 'dfp-tool-meta' }, t('viewer.lines', { count: String(lines.length) })),
          meta.length === 0 ? null : h('span', { className: 'dfp-tool-meta' }, meta.join(' · '))
        ),
        h(
          'div',
          { className: 'dfp-scroll' },
          rendered ? renderMarkdown(value) : h(TextLines, { lines: lines, text: value, wrap: wrap })
        )
      )
    }

    /** Image viewer: fit, wheel zoom 25–800 %, drag pan, double-click toggle. */
    function ImageViewer(props) {
      const runtime = props.runtime
      const t = useLocale(runtime)
      // A URL-backed image (blob:, data:, http(s)) gets the same stage as a file.
      const directSrc = typeof props.src === 'string' && props.src !== '' ? props.src : ''
      const path = directSrc === '' ? props.path : undefined
      const [image, retry] = useAsyncResource(
        runtime,
        directSrc === '' ? 'image:' + path : 'image-src:' + directSrc,
        function (signal) {
          if (directSrc !== '') return Promise.resolve({ phase: 'ready', url: directSrc })
          return runtime.imageUrlFor(path, signal)
        },
        function () {
          return directSrc === '' ? runtime.cachedImageUrl(path) : { phase: 'ready', url: directSrc }
        }
      )
      const [natural, setNatural] = React.useState(null)
      const [fitScale, setFitScale] = React.useState(1)
      const [scale, setScale] = React.useState(1)
      const [pan, setPan] = React.useState({ x: 0, y: 0 })
      const [dragging, setDragging] = React.useState(false)
      const [mode, setMode] = React.useState('fit')
      const [broken, setBroken] = React.useState(false)
      const stageRef = React.useRef(null)
      const scaleRef = React.useRef(1)
      const panRef = React.useRef({ x: 0, y: 0 })
      const dragRef = React.useRef(null)
      const initialised = React.useRef(false)

      const updateScale = React.useCallback(function (value) {
        const next = clamp(value, ZOOM_MIN, ZOOM_MAX)
        scaleRef.current = next
        setScale(next)
        return next
      }, [])

      const updatePan = React.useCallback(function (x, y) {
        const next = { x: x, y: y }
        panRef.current = next
        setPan(next)
      }, [])

      const fitToStage = React.useCallback(
        function () {
          const stage = stageRef.current
          if (stage === null || natural === null) return 1
          const box = stage.getBoundingClientRect()
          if (box.width <= 0 || box.height <= 0 || natural.width <= 0 || natural.height <= 0) return 1
          const fit = Math.min(box.width / natural.width, box.height / natural.height, 1)
          const safe = fit > 0 && Number.isFinite(fit) ? fit : 1
          setFitScale(safe)
          return safe
        },
        [natural]
      )

      React.useEffect(
        function () {
          if (natural === null) return
          const safe = fitToStage()
          if (initialised.current !== true) {
            initialised.current = true
            updateScale(props.initialActual === true ? 1 : safe)
            setMode(props.initialActual === true ? 'actual' : 'fit')
            return
          }
          if (mode === 'fit') updateScale(safe)
        },
        [natural, fitToStage, mode, props.initialActual, updateScale]
      )

      React.useEffect(
        function () {
          const stage = stageRef.current
          if (stage === null || typeof ResizeObserver !== 'function') return
          const observer = new ResizeObserver(function () {
            const safe = fitToStage()
            if (mode === 'fit') updateScale(safe)
          })
          observer.observe(stage)
          return function () {
            observer.disconnect()
          }
        },
        [fitToStage, mode, updateScale]
      )

      React.useEffect(
        function () {
          const stage = stageRef.current
          if (stage === null) return
          const handler = function (event) {
            event.preventDefault()
            const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
            updateScale(scaleRef.current * factor)
          }
          stage.addEventListener('wheel', handler, { passive: false })
          return function () {
            stage.removeEventListener('wheel', handler, { passive: false })
          }
        },
        [updateScale]
      )

      React.useEffect(
        function () {
          if (typeof props.onApi !== 'function') return
          const api = {
            zoomIn: function () {
              updateScale(scaleRef.current * 1.25)
            },
            zoomOut: function () {
              updateScale(scaleRef.current / 1.25)
            },
            reset: function () {
              updateScale(fitScale)
              updatePan(0, 0)
              setMode('fit')
            },
            fit: function () {
              updateScale(fitScale)
              updatePan(0, 0)
              setMode('fit')
            },
            actual: function () {
              updateScale(1)
              updatePan(0, 0)
              setMode('actual')
            },
            panBy: function (dx, dy) {
              updatePan(panRef.current.x + dx, panRef.current.y + dy)
            }
          }
          props.onApi(api)
          return function () {
            props.onApi(null)
          }
        },
        [props.onApi, updateScale, updatePan, fitScale]
      )

      if (image.phase === 'loading') return h(Skeleton, { label: t('state.loadingImage') })
      if (image.phase === 'aborted') return null
      if (image.phase === 'hostMissing') return restartView(t, retry)
      if (image.phase === 'error') return errorView(t, image.code, retry, path !== undefined ? path : directSrc)
      if (broken === true) {
        return h(StateCard, {
          tone: 'error',
          title: t('state.errorTitle'),
          body: [t('state.imageBlocked'), t('state.code', { code: 'image-decode' }), t('state.codeHint')],
          actionLabel: t('state.retry'),
          onAction: function () {
            setBroken(false)
            retry()
          }
        })
      }

      const startDrag = function (event) {
        if (event.button !== 0) return
        event.preventDefault()
        const stage = stageRef.current
        if (stage !== null && typeof stage.setPointerCapture === 'function') {
          try {
            stage.setPointerCapture(event.pointerId)
          } catch (_error) {
            /* capture is optional */
          }
        }
        dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: panRef.current }
        setDragging(true)
      }
      const moveDrag = function (event) {
        const current = dragRef.current
        if (current === null || current.id !== event.pointerId) return
        updatePan(current.origin.x + (event.clientX - current.x), current.origin.y + (event.clientY - current.y))
      }
      const endDrag = function () {
        if (dragRef.current === null) return
        dragRef.current = null
        setDragging(false)
      }
      const toggle = function () {
        if (Math.abs(scaleRef.current - 1) < 0.02) {
          updateScale(fitScale)
          setMode('fit')
        } else {
          updateScale(1)
          setMode('actual')
        }
      }

      return h(
        'div',
        { className: 'dfp-image' },
        h(
          'div',
          { className: 'dfp-image-toolbar' },
          h(
            'button',
            {
              type: 'button',
              className: 'dfp-tool',
              'aria-pressed': mode === 'fit' ? 'true' : 'false',
              title: t('viewer.fit'),
              onClick: function () {
                updateScale(fitScale)
                setMode('fit')
              }
            },
            h(Icon, { name: 'fit', size: 13 }),
            ' ',
            t('viewer.fit')
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dfp-tool',
              'aria-pressed': mode === 'actual' ? 'true' : 'false',
              title: t('viewer.actual'),
              onClick: function () {
                updateScale(1)
                setMode('actual')
              }
            },
            h(Icon, { name: 'actual', size: 13 }),
            ' ',
            t('viewer.actual')
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dfp-iconbtn',
              title: t('viewer.zoomOut'),
              'aria-label': t('viewer.zoomOut'),
              onClick: function () {
                updateScale(scaleRef.current / 1.25)
              }
            },
            h(Icon, { name: 'zoomOut', size: 14 })
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dfp-iconbtn',
              title: t('viewer.zoomIn'),
              'aria-label': t('viewer.zoomIn'),
              onClick: function () {
                updateScale(scaleRef.current * 1.25)
              }
            },
            h(Icon, { name: 'zoomIn', size: 14 })
          ),
          h('span', { className: 'dfp-zoom-label' }, t('header.zoom', { percent: String(Math.round(scale * 100)) }))
        ),
        h(
          'div',
          {
            className: 'dfp-image-stage',
            ref: stageRef,
            'data-dragging': dragging ? 'true' : 'false',
            onDoubleClick: toggle,
            onPointerDown: startDrag,
            onPointerMove: moveDrag,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
            onPointerLeave: endDrag
          },
          h('img', {
            src: image.url,
            alt: t('viewer.imageAlt', { name: props.name }),
            draggable: false,
            onLoad: function (event) {
              const node = event.currentTarget
              if (node.naturalWidth > 0 && node.naturalHeight > 0) {
                setNatural({ width: node.naturalWidth, height: node.naturalHeight })
              }
            },
            onError: function () {
              setBroken(true)
            },
            style: {
              transform: 'translate3d(' + String(pan.x) + 'px,' + String(pan.y) + 'px,0) scale(' + String(scale) + ')',
              // Hidden until the intrinsic size is known, so the first paint is
              // never an unscaled crop of a large image.
              opacity: natural === null ? 0 : 1,
              transition:
                dragging || runtime.reducedMotion()
                  ? 'none'
                  : 'transform 120ms var(--ds-ease-in-out), opacity 120ms linear'
            }
          }),
          h('div', { className: 'dfp-image-hint' }, t('viewer.hint'))
        )
      )
    }

    /** PDF / HTML document frame served from a blob URL. */
    function DocumentFrame(props) {
      const runtime = props.runtime
      const t = useLocale(runtime)
      const kind = props.kind === 'html' ? 'html' : 'pdf'
      const path = props.path
      const [frame, retry] = useAsyncResource(runtime, kind + ':' + path, async function (signal) {
        const raw = await runtime.fetchRawBlob(path, signal)
        if (raw.phase !== 'ready') return raw
        try {
          return {
            phase: 'ready',
            url: URL.createObjectURL(new Blob([raw.blob], { type: kind === 'html' ? 'text/html' : 'application/pdf' }))
          }
        } catch (_error) {
          return { phase: 'error', code: 'blob' }
        }
      })
      const url = frame.phase === 'ready' ? frame.url : null
      React.useEffect(
        function () {
          return function () {
            if (url !== null) {
              try {
                URL.revokeObjectURL(url)
              } catch (_error) {
                /* already revoked */
              }
            }
          }
        },
        [url]
      )
      if (frame.phase === 'loading') {
        return h(Skeleton, { label: t(kind === 'html' ? 'state.loadingDocument' : 'state.loadingFile') })
      }
      if (frame.phase === 'aborted') return null
      if (frame.phase === 'hostMissing') return restartView(t, retry)
      if (frame.phase === 'error') return errorView(t, frame.code, retry, path)
      return h(
        'div',
        { className: 'dfp-doc' },
        h('div', { className: 'dfp-doc-note' }, t('viewer.documentFallback')),
        h('iframe', {
          className: 'dfp-frame',
          src: frame.url,
          title: t('viewer.iframe'),
          sandbox: kind === 'html' ? 'allow-same-origin' : undefined
        })
      )
    }

    /** Office document: host converts it to PDF, which the frame then shows. */
    function OfficeFrame(props) {
      const runtime = props.runtime
      const t = useLocale(runtime)
      const path = props.path
      const [converted, retry] = useAsyncResource(runtime, 'office:' + path, function (signal) {
        return runtime.officePdfUrl(path, signal)
      })
      const url = converted.phase === 'ready' ? converted.url : null
      React.useEffect(
        function () {
          return function () {
            if (url !== null) {
              try {
                URL.revokeObjectURL(url)
              } catch (_error) {
                /* already revoked */
              }
            }
          }
        },
        [url]
      )
      if (converted.phase === 'loading') return h(Skeleton, { label: t('state.loadingOffice') })
      if (converted.phase === 'aborted') return null
      if (converted.phase === 'hostMissing') return restartView(t, retry)
      if (converted.phase === 'unavailable') {
        return h(
          'div',
          { className: 'dfp-doc' },
          h(FileCard, { runtime: runtime, meta: props.meta }),
          h(StateCard, {
            tone: 'info',
            title: t('viewer.office'),
            body: t('state.officeUnavailable'),
            actionLabel: t('state.retry'),
            onAction: retry
          })
        )
      }
      if (converted.phase === 'error') return errorView(t, converted.code, retry, path)
      return h(
        'div',
        { className: 'dfp-doc' },
        h('div', { className: 'dfp-doc-note' }, t('viewer.documentFallback')),
        converted.missingFonts === true ? h('div', { className: 'dfp-notice' }, t('state.officeFonts')) : null,
        h('iframe', { className: 'dfp-frame', src: converted.url, title: t('viewer.iframe') })
      )
    }

    /** Video / audio with native controls, served from a blob URL. */
    function MediaPlayer(props) {
      const runtime = props.runtime
      const t = useLocale(runtime)
      const path = props.path
      const video = props.kind === 'video'
      const [media, retry] = useAsyncResource(runtime, 'media:' + path, async function (signal) {
        const raw = await runtime.fetchRawBlob(path, signal)
        if (raw.phase !== 'ready') return raw
        try {
          return { phase: 'ready', url: URL.createObjectURL(raw.blob) }
        } catch (_error) {
          return { phase: 'error', code: 'blob' }
        }
      })
      const url = media.phase === 'ready' ? media.url : null
      React.useEffect(
        function () {
          return function () {
            if (url !== null) {
              try {
                URL.revokeObjectURL(url)
              } catch (_error) {
                /* already revoked */
              }
            }
          }
        },
        [url]
      )
      if (media.phase === 'loading') return h(Skeleton, { label: t('state.loadingMedia') })
      if (media.phase === 'aborted') return null
      if (media.phase === 'hostMissing') return restartView(t, retry)
      if (media.phase === 'error') return errorView(t, media.code, retry, path)
      return h(
        'div',
        { className: 'dfp-media-wrap' },
        video
          ? h('video', { className: 'dfp-media', src: media.url, controls: true, preload: 'metadata' })
          : h('audio', { className: 'dfp-media dfp-audio', src: media.url, controls: true, preload: 'metadata' })
      )
    }

    /**
     * A blob:/data:/http(s) image (a pasted or attached bitmap, a remote image):
     * the very same zoomable stage as a path-backed file, backed by its URL.
     */
    function RemoteImage(props) {
      const t = useLocale(props.runtime)
      const name = typeof props.name === 'string' && props.name !== '' ? props.name : t('state.remoteImage')
      return h(ImageViewer, { runtime: props.runtime, src: props.src, name: name })
    }

    /** Localized label of a host `kind` enum; unknown values are omitted entirely. */
    function kindText(kind, t) {
      if (kind === 'file') return t('viewer.kindFile')
      if (kind === 'directory') return t('viewer.kindDirectory')
      if (kind === 'other') return t('viewer.kindOther')
      return ''
    }

    /** Metadata card for binary/unknown files and for name-only attachments. */
    function FileCard(props) {
      const runtime = props.runtime
      const t = useLocale(runtime)
      const meta = props.meta !== undefined && props.meta !== null ? props.meta : null
      const name = meta !== null && typeof meta.name === 'string' && meta.name !== '' ? meta.name : String(props.name || '')
      const extension = meta !== null && typeof meta.ext === 'string' && meta.ext !== '' ? meta.ext : pathExtension(name)
      const facts = []
      if (meta !== null && Number.isFinite(meta.size)) facts.push(runtime.formatBytes(meta.size))
      if (meta !== null && Number.isFinite(meta.mtimeMs)) facts.push(runtime.formatDate(meta.mtimeMs))
      const kind = meta !== null && typeof meta.kind === 'string' ? kindText(meta.kind, t) : ''
      if (kind !== '') facts.push(kind)
      const displayPath =
        meta !== null && typeof meta.absPath === 'string'
          ? meta.absPath
          : meta !== null && typeof meta.relPath === 'string'
            ? meta.relPath
            : ''
      return h(
        'div',
        { className: 'dfp-filecard' },
        h('span', { className: 'dfp-filecard-badge' }, (extension !== '' ? extension : t('header.badgeFile')).toUpperCase().slice(0, 10)),
        h(
          'div',
          { className: 'dfp-filecard-body' },
          h('div', { className: 'dfp-filecard-name' }, name),
          facts.length === 0 ? null : h('div', { className: 'dfp-filecard-meta' }, facts.join(' · ')),
          displayPath === '' ? null : h('div', { className: 'dfp-filecard-path' }, displayPath),
          props.title === undefined ? null : h('div', { className: 'dfp-state-title' }, props.title),
          props.notice === undefined ? null : h('div', { className: 'dfp-state-body' }, props.notice)
        )
      )
    }

    /** Website card: host, title, description, favicon, og image, open button. */
    function WebsiteCard(props) {
      const runtime = props.runtime
      const state = props.state
      const onNotify = props.onNotify
      const t = useLocale(runtime)
      const [link, retry] = useAsyncResource(
        runtime,
        'link:' + state.url,
        function (signal) {
          return runtime.fetchLink(state.url, signal)
        },
        function () {
          return runtime.cachedLink(state.url)
        }
      )
      const openInBrowser = function () {
        Promise.resolve(runtime.perform('browser', { url: state.url })).then(onNotify)
      }
      if (link.phase === 'loading') return h(Skeleton, { label: t('web.loading') })
      if (link.phase === 'aborted') return null
      const info =
        link.phase === 'ready'
          ? link.link
          : {
              url: state.url,
              host: hostOf(state.url),
              title: '',
              description: '',
              siteName: '',
              icon: '',
              image: ''
            }
      const host = info.host !== '' ? info.host : hostOf(info.url)
      const partial = link.phase === 'ready' && link.link.partial === true
      return h(
        'div',
        { className: 'dfp-web' },
        info.image === '' ? null : h('img', { className: 'dfp-web-image', src: info.image, alt: '', loading: 'lazy' }),
        h(
          'div',
          { className: 'dfp-web-body' },
          h(
            'div',
            { className: 'dfp-web-head' },
            info.icon === '' ? h(Icon, { name: 'globe', size: 16 }) : h('img', { className: 'dfp-web-icon', src: info.icon, alt: '' }),
            h('span', null, host === '' ? t('web.host') : host),
            info.siteName === '' ? null : h('span', null, '· ' + info.siteName)
          ),
          h('h3', { className: 'dfp-web-title' }, info.title !== '' ? info.title : host),
          h('div', { className: 'dfp-web-desc' }, info.description !== '' ? info.description : t('web.description')),
          h('div', { className: 'dfp-web-url' }, info.url),
          link.phase === 'ready' && partial === false ? null : h('div', { className: 'dfp-state-body' }, t('web.unavailable')),
          link.phase === 'ready' && partial === false
            ? null
            : h('button', { type: 'button', className: 'dfp-tool', onClick: retry }, t('state.retry')),
          h(
            'button',
            { type: 'button', className: 'dfp-link-btn', onClick: openInBrowser, title: t('web.open') },
            h(Icon, { name: 'open', size: 15 }),
            t('web.open')
          )
        )
      )
    }

    /** The host part of a URL, or an empty string. */
    function hostOf(url) {
      try {
        return new URL(url).host
      } catch (_error) {
        return ''
      }
    }

    /** Restart hint shown when the host half answers with a non-plugin body. */
    function restartView(t, retry) {
      return h(StateCard, {
        tone: 'error',
        title: t('state.restartTitle'),
        body: [t('state.restartBody'), t('state.code', { code: 'host-missing' }), t('state.codeHint')],
        actionLabel: t('state.retry'),
        onAction: retry
      })
    }

    /** Failure codes that carry the requested path into the card. */
    const PATH_FAILURE_CODES = ['not-found', 'denied', 'forbidden', 'permission', 'permission-denied', 'outside-allowed-roots']

    /**
     * Map a failure code to a user-readable, self-diagnosing state card.
     * The card always names the failure code; the not-found / denied /
     * outside-allowed-roots family also names the requested path, and the
     * outside-allowed-roots case points at the host `readScope` setting, so a
     * report from the owner carries everything needed to trace the failure.
     * @param t - locale translate function.
     * @param code - host or transport failure code.
     * @param retry - retry callback.
     * @param requestedPath - what the user asked to preview.
     */
    function errorView(t, code, retry, requestedPath) {
      const failure = typeof code === 'string' && code !== '' ? code : 'unknown'
      let title = t('state.errorTitle')
      let body = t('state.errorBody')
      if (failure === 'not-found') {
        title = t('state.notFoundTitle')
        body = t('state.notFoundBody')
      } else if (failure === 'denied' || failure === 'forbidden' || failure === 'permission' || failure === 'permission-denied') {
        title = t('state.deniedTitle')
        body = t('state.deniedBody')
      } else if (failure === 'outside-allowed-roots') {
        title = t('state.outsideRootsTitle')
        body = t('state.outsideRootsBody')
      } else if (failure === 'too-large' || failure === 'input-too-large' || failure === 'output-too-large') {
        title = t('state.tooLargeTitle')
        body = t('state.tooLargeBody')
      } else if (failure === 'network') {
        body = t('state.errorNetwork')
      }
      const lines = [body, t('state.code', { code: failure })]
      if (PATH_FAILURE_CODES.indexOf(failure) !== -1 && typeof requestedPath === 'string' && requestedPath !== '') {
        lines.push(t('state.requestedPath', { path: middleTruncate(requestedPath, 38, 26) }))
      }
      if (failure === 'outside-allowed-roots') lines.push(t('state.readScopeHint'))
      lines.push(t('state.codeHint'))
      return h(StateCard, {
        tone: 'error',
        title: title,
        body: lines,
        actionLabel: t('state.retry'),
        onAction: retry
      })
    }

    /** The path the user asked for, taken from the state or its metadata. */
    function requestedPathOf(state, metaState) {
      if (metaState !== null && metaState !== undefined && metaState.meta !== null && metaState.meta !== undefined) {
        if (typeof metaState.meta.absPath === 'string' && metaState.meta.absPath !== '') return metaState.meta.absPath
        if (typeof metaState.meta.relPath === 'string' && metaState.meta.relPath !== '') return metaState.meta.relPath
      }
      if (state !== null && state !== undefined) {
        if (typeof state.path === 'string' && state.path !== '') return state.path
        if (typeof state.name === 'string' && state.name !== '') return state.name
      }
      return ''
    }

    /** Hover-mode segmented control, persisted across reloads. */
    function ModeSegment(props) {
      const runtime = props.runtime
      const t = useLocale(runtime)
      const mode = useStore(runtime.modeStore)
      const labels = {
        peek: t('segment.peek'),
        full: t('segment.full'),
        off: t('segment.off')
      }
      const titles = {
        peek: t('segment.peekTitle'),
        full: t('segment.fullTitle'),
        off: t('segment.offTitle')
      }
      return h(
        'div',
        { className: 'dfp-seg', role: 'group', 'aria-label': t('segment.label') },
        h('span', { className: 'dfp-seg-label' }, t('segment.label')),
        PEEK_MODES.map(function (value) {
          return h(
            'button',
            {
              key: value,
              type: 'button',
              'aria-pressed': mode === value ? 'true' : 'false',
              title: titles[value],
              onClick: function () {
                runtime.setHoverMode(value)
              }
            },
            labels[value]
          )
        })
      )
    }

    /** Footer action bar: icon, label, hotkey chip, disabled state. */
    function ActionBar(props) {
      const runtime = props.runtime
      const t = useLocale(runtime)
      const actions = props.actions
      const labels = {
        browser: t('action.browser'),
        reveal: t('action.reveal'),
        open: t('action.open')
      }
      const icons = { browser: 'globe', reveal: 'folder', open: 'open' }
      const hints = {
        browser: runtime.keyChip('browser'),
        reveal: runtime.keyChip('reveal'),
        open: runtime.keyChip('open')
      }
      const copyMainKey = props.copyAction === 'copy-text' || props.copyAction === 'copy-image' ? 'contents' : 'path'
      return h(
        'footer',
        { className: 'dfp-foot' },
        h(
          'div',
          { className: 'dfp-actions' },
          h(CopyControl, {
            runtime: runtime,
            target: props.target,
            mainKey: copyMainKey,
            onRun: function (key) {
              props.onRun(key)
            }
          }),
          ['browser', 'reveal', 'open'].map(function (key) {
            const enabled = actions[key] === true
            return h(
              'button',
              {
                key: key,
                type: 'button',
                className: 'dfp-action',
                disabled: enabled !== true,
                title: enabled === true ? labels[key] + ' · ' + hints[key] : t('action.noPath'),
                'aria-label': labels[key] + ' (' + hints[key] + ')',
                'aria-keyshortcuts': runtime.keyAria(key),
                onClick: function () {
                  props.onRun(key)
                }
              },
              h(Icon, { name: icons[key], size: 14 }),
              h('span', null, labels[key]),
              h('span', { className: 'dfp-kbd' }, hints[key])
            )
          })
        )
      )
    }

    /**
     * What the copy split button offers for one target.
     * @param target - the action target (`{path, displayPath, meta, src}`).
     * @returns `{path, contents, file}` where each entry is `{enabled, reasonKey}`.
     */
    function copyPlanFor(target) {
      const known = target !== null && target !== undefined
      const hasDisplayPath = known && typeof target.displayPath === 'string' && target.displayPath !== ''
      const hasAbsolute = known && typeof target.path === 'string' && isAbsolutePath(target.path)
      let contentsEnabled = false
      if (known) {
        if (typeof target.src === 'string' && target.src !== '') contentsEnabled = true
        else if (target.meta !== undefined && target.meta !== null) {
          contentsEnabled = target.meta.preview === 'image' || isTextPreview(target.meta.preview)
        }
      }
      return {
        path: { enabled: hasDisplayPath, reasonKey: 'action.noPath' },
        contents: { enabled: contentsEnabled, reasonKey: 'copy.contentsUnavailable' },
        file: { enabled: hasAbsolute, reasonKey: 'action.noPath' }
      }
    }

    /**
     * Split copy control: the primary button runs the smart copy (Ctrl/Cmd+C),
     * the chevron opens a menu with the three explicit choices. Used both in the
     * modal footer and in the hover card.
     */
    function CopyControl(props) {
      const runtime = props.runtime
      const t = useLocale(runtime)
      const plan = copyPlanFor(props.target)
      const compact = props.compact === true
      const [open, setOpen] = React.useState(false)
      const toggleRef = React.useRef(null)
      const menuRef = React.useRef(null)
      const labels = { path: t('copy.path'), contents: t('copy.contents'), file: t('copy.file') }
      const hints = { path: runtime.keyChip('copy'), contents: runtime.keyChip('copy'), file: '' }
      const mainKey = props.mainKey === 'contents' || props.mainKey === 'file' ? props.mainKey : 'path'
      const mainLabel = labels[mainKey]
      const mainEnabled = plan[mainKey].enabled === true
      const anyEnabled = plan.path.enabled === true || plan.contents.enabled === true || plan.file.enabled === true

      const focusToggle = function () {
        const toggle = toggleRef.current
        if (toggle !== null && toggle !== undefined && typeof toggle.focus === 'function') {
          try {
            toggle.focus()
          } catch (_error) {
            /* focus is best-effort */
          }
        }
      }
      const closeMenu = function (returnFocus) {
        setOpen(false)
        runtime.setMenuOpen(false)
        if (returnFocus === true) focusToggle()
      }
      /** Menu keys are the visible choices; perform() takes the action ids. */
      const ACTION_BY_CHOICE = { path: 'copy-path', contents: 'copy-contents', file: 'copy-file' }
      const choose = function (choice) {
        closeMenu(true)
        props.onRun(ACTION_BY_CHOICE[choice])
      }
      const toggleMenu = function () {
        const next = open !== true
        setOpen(next)
        runtime.setMenuOpen(next)
      }
      const onMenuKeyDown = function (event) {
        try {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            closeMenu(true)
            return
          }
          if (event.key === 'Tab') {
            closeMenu(false)
            return
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const menu = menuRef.current
            if (menu === null || menu === undefined || typeof menu.querySelectorAll !== 'function') return
            const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(function (item) {
              return item.disabled !== true
            })
            if (items.length === 0) return
            const index = items.indexOf(document.activeElement)
            const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length
            const target = items[next]
            if (target !== undefined && typeof target.focus === 'function') target.focus()
          }
        } catch (_error) {
          /* a broken key handler must not break the menu */
        }
      }

      const items = ['path', 'contents', 'file'].map(function (key) {
        const entry = plan[key]
        const enabled = entry.enabled === true
        return h(
          'button',
          {
            key: key,
            type: 'button',
            role: 'menuitem',
            className: 'dfp-menu-item',
            disabled: enabled !== true,
            title: enabled === true ? labels[key] : t(entry.reasonKey),
            'aria-label': enabled === true ? labels[key] : labels[key] + ' — ' + t(entry.reasonKey),
            onClick: function () {
              if (enabled === true) choose(key)
            }
          },
          h(Icon, { name: key === 'contents' ? 'source' : key === 'file' ? 'file' : 'copy', size: 13 }),
          h('span', null, labels[key]),
          enabled === true
            ? hints[key] === ''
              ? null
              : h('span', { className: 'dfp-kbd' }, hints[key])
            : h('span', { className: 'dfp-menu-reason' }, t(entry.reasonKey))
        )
      })

      const primary = compact
        ? h(
            'button',
            {
              type: 'button',
              className: 'dfp-peek-action',
              disabled: mainEnabled !== true,
              title: mainEnabled === true ? mainLabel : t('action.noPath'),
              'aria-label': mainLabel,
              onClick: function () {
                props.onRun('copy')
              }
            },
            h(Icon, { name: 'copy', size: 14 })
          )
        : h(
            'button',
            {
              type: 'button',
              className: 'dfp-action dfp-split-main',
              disabled: mainEnabled !== true,
              title: mainEnabled === true ? mainLabel + ' · ' + hints[mainKey] : t('action.noPath'),
              'aria-label': mainLabel + ' (' + hints[mainKey] + ')',
              'aria-keyshortcuts': runtime.keyAria('copy'),
              onClick: function () {
                props.onRun('copy')
              }
            },
            h(Icon, { name: 'copy', size: 14 }),
            h('span', null, mainLabel),
            h('span', { className: 'dfp-kbd' }, hints[mainKey])
          )

      return h(
        'div',
        { className: compact ? 'dfp-split dfp-split-compact' : 'dfp-split' },
        primary,
        h(
          'button',
          {
            ref: toggleRef,
            type: 'button',
            className: compact ? 'dfp-peek-action dfp-split-toggle-compact' : 'dfp-split-toggle',
            'aria-haspopup': 'menu',
            'aria-expanded': open === true ? 'true' : 'false',
            'aria-label': t('copy.toggle'),
            title: t('copy.menu'),
            disabled: anyEnabled !== true,
            onClick: toggleMenu
          },
          h(Icon, { name: 'chevron', size: compact ? 11 : 12 })
        ),
        open === true
          ? h(
              'div',
              {
                ref: menuRef,
                className: compact ? 'dfp-menu dfp-menu-compact' : 'dfp-menu',
                role: 'menu',
                'aria-label': t('copy.menu'),
                onKeyDown: onMenuKeyDown
              },
              items
            )
          : null
      )
    }

    /** Build the action target of the current overlay state. */
    function buildPerformTarget(state, metaState) {
      if (state.kind === 'web') return { url: state.url, displayPath: state.url }
      if (metaState === null || metaState === undefined) return null
      if (metaState.phase === 'ready' && (metaState.meta === null || metaState.meta === undefined)) {
        return { src: metaState.remote !== undefined && metaState.remote !== null ? metaState.remote.src : undefined }
      }
      if (metaState.phase === 'ready') {
        const meta = metaState.meta
        return {
          path: meta.absPath,
          displayPath: meta.absPath !== undefined ? meta.absPath : meta.relPath,
          name: meta.name,
          meta: meta
        }
      }
      return null
    }

    /** Which copy flavour the copy button performs. */
    function copyActionFor(state, metaState) {
      if (state.kind === 'web') return 'copy-link'
      if (metaState !== null && metaState !== undefined && metaState.phase === 'ready') {
        if (metaState.meta === null || metaState.meta === undefined) return 'copy-image'
        if (metaState.meta.preview === 'image') return 'copy-image'
        if (isTextPreview(metaState.meta.preview)) return 'copy-text'
      }
      return 'copy-path'
    }

    /** Which footer actions are usable for the current overlay state. */
    function actionPermissions(target, copyAction) {
      if (target === null || target === undefined) {
        return { copy: false, browser: false, reveal: false, open: false }
      }
      const hasAbsolute = typeof target.path === 'string' && isAbsolutePath(target.path)
      return {
        copy: copyAction !== 'copy-path' || typeof target.displayPath === 'string' || hasAbsolute,
        browser: typeof target.url === 'string' || hasAbsolute,
        reveal: hasAbsolute,
        open: hasAbsolute
      }
    }

    /**
     * Comfortable panel width per content type; the CSS cap stays the maximum.
     * Media needs room, a link card or a metadata card must not look empty.
     */
    function panelWidthFor(state, metaState) {
      if (state.kind === 'web') return 760
      if (metaState !== null && metaState !== undefined && metaState.phase === 'ready' && metaState.meta !== null && metaState.meta !== undefined) {
        const preview = metaState.meta.preview
        if (preview === 'image' || preview === 'pdf' || preview === 'office' || preview === 'html' || preview === 'video' || preview === 'audio') {
          return 1200
        }
        if (isTextPreview(preview)) return 1040
        return 760
      }
      return 860
    }

    /** Header badge text and title. */
    function badgeFor(state, metaState, t) {
      if (state.kind === 'web') return { text: t('header.badgeLink'), title: t('web.title') }
      if (
        metaState !== null &&
        metaState !== undefined &&
        metaState.phase === 'ready' &&
        (metaState.meta === null || metaState.meta === undefined)
      ) {
        return { text: t('header.badgeImage'), title: t('viewer.image') }
      }
      if (metaState !== null && metaState !== undefined && metaState.phase === 'ready' && metaState.meta !== null && metaState.meta !== undefined) {
        const meta = metaState.meta
        const text = typeof meta.ext === 'string' && meta.ext !== '' ? meta.ext.toUpperCase().slice(0, 8) : t('header.badgeFile')
        if (meta.preview === 'image') return { text: text, title: t('viewer.image') }
        if (meta.preview === 'pdf') return { text: text, title: t('viewer.pdf') }
        if (meta.preview === 'office') return { text: text, title: t('viewer.office') }
        if (meta.preview === 'video') return { text: text, title: t('viewer.video') }
        if (meta.preview === 'audio') return { text: text, title: t('viewer.audio') }
        if (isTextPreview(meta.preview)) return { text: text, title: t('viewer.text') }
        return { text: text, title: t('viewer.binary') }
      }
      if (typeof state.path === 'string' && state.path !== '') {
        const ext = pathExtension(state.path)
        return { text: ext !== '' ? ext.toUpperCase().slice(0, 8) : t('header.badgeFile'), title: '' }
      }
      return { text: t('header.badgeFile'), title: '' }
    }
    //#endregion

    //#region Modal
    /** Width of the element that invoked the overlay, for thumbnail detection. */
    function renderedWidthOf(element) {
      try {
        if (element === null || element === undefined || typeof element.getBoundingClientRect !== 'function') return 0
        return element.getBoundingClientRect().width
      } catch (_error) {
        return 0
      }
    }

    /**
     * The in-chat preview modal: chrome, viewer, action bar, hotkeys and the
     * focus trap. Everything it owns is released when it unmounts (which is
     * what closing does), including the focus it restores to the invoker.
     */
    function PreviewModal(props) {
      const runtime = props.runtime
      const state = props.state
      const t = useLocale(runtime)
      const [closing, setClosing] = React.useState(false)
      const [toast, setToast] = React.useState(null)
      const panelRef = React.useRef(null)
      const viewerRef = React.useRef(null)
      const closeTimer = React.useRef(0)
      const toastTimer = React.useRef(0)
      const toastSeq = React.useRef(0)
      const closeRequested = React.useRef(false)

      const requestClose = React.useCallback(
        function () {
          if (closeRequested.current === true) return
          closeRequested.current = true
          setClosing(true)
          closeTimer.current = window.setTimeout(function () {
            closeTimer.current = 0
            runtime.closePreview()
          }, EXIT_MS)
        },
        [runtime]
      )

      const notify = React.useCallback(function (result) {
        if (result === null || result === undefined || typeof result.toast !== 'string') return
        toastSeq.current += 1
        setToast({ key: result.toast, tone: result.tone === 'error' ? 'error' : 'ok', id: toastSeq.current })
        if (toastTimer.current !== 0) window.clearTimeout(toastTimer.current)
        toastTimer.current = window.setTimeout(function () {
          toastTimer.current = 0
          setToast(null)
        }, TOAST_MS)
      }, [])

      React.useEffect(function () {
        return function () {
          if (closeTimer.current !== 0) window.clearTimeout(closeTimer.current)
          if (toastTimer.current !== 0) window.clearTimeout(toastTimer.current)
        }
      }, [])

      const [metaState, retry] = useAsyncResource(
        runtime,
        'modal:' + descriptorKey(state),
        function (signal) {
          if (state.kind === 'web') return Promise.resolve({ phase: 'web' })
          // The modal refreshes metadata; the seed above already painted it.
          return runtime.resolveDescriptor(state, signal, { force: true })
        },
        function () {
          return state.kind === 'web' ? { phase: 'web' } : runtime.cachedMeta(state)
        }
      )

      const target = React.useMemo(
        function () {
          return buildPerformTarget(state, metaState)
        },
        [state, metaState]
      )
      const copyAction = copyActionFor(state, metaState)
      const permissions = React.useMemo(
        function () {
          return actionPermissions(target, copyAction)
        },
        [target, copyAction]
      )
      const initialActual = React.useMemo(
        function () {
          const width = renderedWidthOf(state.sourceEl)
          return width > 0 && width < 96
        },
        [state.sourceEl]
      )

      const invokeRef = React.useRef(function () {})
      invokeRef.current = React.useCallback(
        function (key) {
          // The copy menu offers explicit choices; its entries already carry
          // their own enabled state, so they bypass the coarse permission map.
          const explicit = key === 'copy-path' || key === 'copy-contents' || key === 'copy-file'
          let resolved = key
          if (explicit !== true) {
            // Enter is the primary action: for a website that is the browser.
            resolved = key === 'open' && permissions.open !== true && permissions.browser === true ? 'browser' : key
            if (permissions[resolved] !== true) return
          }
          const action = resolved === 'copy' ? copyAction : resolved
          Promise.resolve(runtime.perform(action, target)).then(notify, function () {
            notify({ ok: false, tone: 'error', toast: 'toast.failed' })
          })
        },
        [runtime, permissions, copyAction, target, notify]
      )

      const setViewerApi = React.useCallback(function (api) {
        viewerRef.current = api
      }, [])

      React.useEffect(
        function () {
          const panel = panelRef.current
          if (panel === null) return
          const source = state.sourceEl
          const restore = source !== undefined && source !== null && source.isConnected !== false ? source : document.activeElement
          const focusable = function () {
            return Array.from(panel.querySelectorAll(FOCUSABLE)).filter(function (element) {
              if (element.disabled === true) return false
              if (element.getAttribute('aria-hidden') === 'true') return false
              return element.offsetWidth > 0 || element.offsetHeight > 0 || element === document.activeElement
            })
          }
          const auto = panel.querySelector('[data-modal-autofocus]')
          const focusTarget = auto !== null ? auto : panel
          if (panel.contains(document.activeElement) !== true) {
            try {
              focusTarget.focus({ preventScroll: true })
            } catch (_error) {
              try {
                focusTarget.focus()
              } catch (_inner) {
                /* focus is best-effort */
              }
            }
          }
          const onKey = function (event) {
            try {
              if (event.isComposing === true) return
              if (event.defaultPrevented) return
              const key = event.key
              if (key === 'Escape') {
                if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return
                // An open copy menu owns Escape: its handler closes the menu and
                // returns focus to the split button, the modal stays open.
                if (runtime.isMenuOpen() === true) return
                event.preventDefault()
                event.stopPropagation()
                requestClose()
                return
              }
              if (key === 'Tab') {
                const list = focusable()
                if (list.length === 0) {
                  event.preventDefault()
                  panel.focus()
                  return
                }
                const first = list[0]
                const last = list[list.length - 1]
                const active = document.activeElement
                if (event.shiftKey === true) {
                  if (active === first || panel.contains(active) !== true) {
                    event.preventDefault()
                    last.focus()
                  }
                } else if (active === last || panel.contains(active) !== true) {
                  event.preventDefault()
                  first.focus()
                }
                return
              }
              const primary = event.ctrlKey === true || event.metaKey === true
              if (primary && event.altKey !== true) {
                const code = String(event.key || '').toLowerCase()
                if (event.shiftKey !== true) {
                  if (code === 'c') {
                    event.preventDefault()
                    invokeRef.current('copy')
                    return
                  }
                  if (code === 'b') {
                    event.preventDefault()
                    invokeRef.current('browser')
                    return
                  }
                  if (code === 'e') {
                    event.preventDefault()
                    invokeRef.current('reveal')
                    return
                  }
                }
                return
              }
              const api = viewerRef.current
              if (api !== null && api !== undefined) {
                if (key === '+' || key === '=') {
                  event.preventDefault()
                  api.zoomIn()
                  return
                }
                if (key === '-' || key === '_') {
                  event.preventDefault()
                  api.zoomOut()
                  return
                }
                if (key === '0') {
                  event.preventDefault()
                  api.reset()
                  return
                }
                if (key === 'ArrowLeft') {
                  event.preventDefault()
                  api.panBy(48, 0)
                  return
                }
                if (key === 'ArrowRight') {
                  event.preventDefault()
                  api.panBy(-48, 0)
                  return
                }
                if (key === 'ArrowUp') {
                  event.preventDefault()
                  api.panBy(0, 48)
                  return
                }
                if (key === 'ArrowDown') {
                  event.preventDefault()
                  api.panBy(0, -48)
                  return
                }
              }
              if (key === 'Enter') {
                const active = document.activeElement
                if (active !== null && active !== panel && panel.contains(active) === true) {
                  const tag = String(active.tagName || '')
                  if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
                }
                event.preventDefault()
                invokeRef.current('open')
              }
            } catch (_error) {
              /* a broken hotkey must not break the dialog */
            }
          }
          window.addEventListener('keydown', onKey, true)
          return function () {
            window.removeEventListener('keydown', onKey, true)
            try {
              if (restore !== null && restore !== undefined && typeof restore.focus === 'function' && restore.isConnected !== false) {
                restore.focus({ preventScroll: true })
              }
            } catch (_error) {
              /* the invoker may be gone */
            }
          }
        },
        [requestClose, state]
      )

      const meta = metaState !== null && metaState.phase === 'ready' && metaState.meta !== null && metaState.meta !== undefined ? metaState.meta : null
      let displayName = ''
      if (meta !== null) displayName = meta.name
      else if (typeof state.name === 'string' && state.name !== '') displayName = state.name
      else if (state.kind === 'web') displayName = hostOf(state.url)
      else if (typeof state.path === 'string' && state.path !== '') displayName = pathBasename(state.path)
      if (displayName === '') displayName = t('dialog.aria')
      const subParts = []
      if (meta !== null) {
        if (Number.isFinite(meta.size)) subParts.push(runtime.formatBytes(meta.size))
        if (Number.isFinite(meta.mtimeMs)) subParts.push(runtime.formatDate(meta.mtimeMs))
      } else if (state.kind === 'web') {
        const host = hostOf(state.url)
        if (host !== '') subParts.push(host)
      }
      let displayPath = ''
      if (meta !== null && typeof meta.absPath === 'string') displayPath = meta.absPath
      else if (meta !== null && typeof meta.relPath === 'string') displayPath = meta.relPath
      else if (state.kind === 'file' && typeof state.path === 'string') displayPath = state.path
      const badge = badgeFor(state, metaState, t)
      const panelWidth = panelWidthFor(state, metaState)

      const modalBody = function () {
        try {
          if (state.kind === 'web') return h(WebsiteCard, { runtime: runtime, state: state, onNotify: notify })
          if (metaState.phase === 'loading') return h(Skeleton, { label: t('state.loading') })
          if (metaState.phase === 'aborted') return null
          if (metaState.phase === 'hostMissing') return restartView(t, retry)
          if (metaState.phase === 'error') return errorView(t, metaState.code, retry, requestedPathOf(state, metaState))
          if (metaState.phase === 'nameOnly') {
            return h(FileCard, {
              runtime: runtime,
              name: metaState.name,
              title: t('state.attachmentUnavailable'),
              notice: t('state.pathUnknown')
            })
          }
          if (metaState.phase !== 'ready') return null
          if (metaState.meta === null || metaState.meta === undefined) {
            return h(RemoteImage, {
              runtime: runtime,
              src: metaState.remote !== undefined && metaState.remote !== null ? metaState.remote.src : '',
              name: metaState.remote !== undefined && metaState.remote !== null ? metaState.remote.name : ''
            })
          }
          const info = metaState.meta
          const path = info.absPath !== undefined ? info.absPath : info.relPath
          if (info.canRead === false && info.reason === 'not-readable') {
            return h(
              'div',
              { className: 'dfp-doc' },
              h(FileCard, { runtime: runtime, meta: info }),
              errorView(t, 'denied', retry, requestedPathOf(state, metaState))
            )
          }
          if (info.preview === 'image') {
            return h(ImageViewer, { runtime: runtime, path: path, name: info.name, initialActual: initialActual, onApi: setViewerApi })
          }
          if (info.preview === 'pdf') return h(DocumentFrame, { runtime: runtime, kind: 'pdf', path: path })
          if (info.preview === 'office') return h(OfficeFrame, { runtime: runtime, path: path, meta: info })
          if (info.preview === 'html') return h(DocumentFrame, { runtime: runtime, kind: 'html', path: path })
          if (info.preview === 'markdown') return h(TextPanel, { runtime: runtime, path: path, meta: info, markdown: true })
          if (info.preview === 'text' || info.preview === 'code') {
            return h(TextPanel, { runtime: runtime, path: path, meta: info, markdown: false })
          }
          if (info.preview === 'video') return h(MediaPlayer, { runtime: runtime, path: path, kind: 'video' })
          if (info.preview === 'audio') return h(MediaPlayer, { runtime: runtime, path: path, kind: 'audio' })
          return h(FileCard, { runtime: runtime, meta: info, title: t('state.binaryTitle'), notice: t('state.binaryBody') })
        } catch (_error) {
          return errorView(t, 'unknown', retry, requestedPathOf(state, metaState))
        }
      }

      return h(
        'div',
        { className: 'dfp-modal-root', 'data-closing': closing ? 'true' : 'false' },
        h('div', { className: 'dfp-mask', 'aria-hidden': 'true', onClick: requestClose }),
        h(
          'div',
          {
            className: 'dfp-panel',
            style: { width: 'min(' + String(panelWidth) + 'px, 92vw)' },
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': TITLE_ID,
            tabIndex: -1,
            ref: panelRef,
            'data-modal-autofocus': 'true'
          },
          h(
            'header',
            { className: 'dfp-head' },
            h('span', { className: 'dfp-badge', title: badge.title !== '' ? badge.title : displayName }, badge.text),
            h(
              'div',
              { className: 'dfp-heading' },
              h('h2', { className: 'dfp-title', id: TITLE_ID, title: displayName }, middleTruncate(displayName, 36, 18)),
              subParts.length === 0 ? null : h('div', { className: 'dfp-sub' }, subParts.join(' · ')),
              displayPath === '' ? null : h('div', { className: 'dfp-path', title: displayPath }, middleTruncate(displayPath, 34, 26))
            ),
            h(
              'div',
              { className: 'dfp-head-tools' },
              h(ModeSegment, { runtime: runtime }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dfp-iconbtn',
                  onClick: requestClose,
                  'aria-label': t('dialog.close'),
                  title: t('dialog.closeTitle')
                },
                h(Icon, { name: 'close' })
              )
            )
          ),
          h('div', { className: 'dfp-body' }, modalBody()),
          h(ActionBar, {
            runtime: runtime,
            actions: permissions,
            copyAction: copyAction,
            target: target,
            onRun: function (key) {
              invokeRef.current(key)
            }
          }),
          toast === null
            ? null
            : h(
                'div',
                { className: 'dfp-toast', role: 'status', 'aria-live': 'polite', 'data-tone': toast.tone, key: toast.id },
                t(toast.key)
              )
        )
      )
    }
    //#endregion

    //#region Hover card
    /** Place the card beside the anchor, flipped and clamped to the viewport. */
    function computePlacement(rect, mode) {
      const width = Math.max(
        260,
        Math.min(
          mode === 'full' ? Math.min(FULL_WIDTH, window.innerWidth * 0.6) : PEEK_WIDTH,
          window.innerWidth - VIEWPORT_MARGIN * 2
        )
      )
      const maxHeight = mode === 'full' ? FULL_MAX_HEIGHT : PEEK_MAX_HEIGHT
      const spaceBelow = window.innerHeight - rect.bottom - ANCHOR_GAP - VIEWPORT_MARGIN
      const spaceAbove = rect.top - ANCHOR_GAP - VIEWPORT_MARGIN
      const preferAbove = spaceAbove >= Math.min(maxHeight, spaceBelow) && spaceBelow < maxHeight
      const heightLimit = Math.max(180, Math.min(maxHeight, preferAbove ? spaceAbove : spaceBelow))
      return {
        left: clamp(rect.left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN)),
        top: preferAbove
          ? Math.max(VIEWPORT_MARGIN, rect.top - ANCHOR_GAP - heightLimit)
          : Math.min(window.innerHeight - VIEWPORT_MARGIN - heightLimit, rect.bottom + ANCHOR_GAP),
        width: width,
        heightLimit: heightLimit
      }
    }

    /**
     * The single hover card: compact (`peek`) and rich (`full`) share this
     * component, the controller guarantees at most one of them exists.
     */
    function HoverPeek(props) {
      const runtime = props.runtime
      const state = props.state
      const descriptor = state.descriptor
      const t = useLocale(runtime)
      const [data, retry] = useAsyncResource(
        runtime,
        'peek:' + state.key + ':' + state.mode,
        function (signal) {
          return runtime.loadPeek(descriptor, state.mode, signal)
        },
        function () {
          return runtime.cachedPeek(descriptor, state.mode)
        }
      )
      const [placement] = React.useState(function () {
        return computePlacement(state.rect, state.mode)
      })
      const [offset, setOffset] = React.useState({ x: 0, y: 0 })
      const [flash, setFlash] = React.useState(null)
      const cardRef = React.useRef(null)
      const flashTimer = React.useRef(0)
      const setCard = React.useCallback(
        function (node) {
          cardRef.current = node
          runtime.setPopover(node)
        },
        [runtime]
      )
      React.useEffect(
        function () {
          return function () {
            runtime.setPopover(null)
            if (flashTimer.current !== 0) window.clearTimeout(flashTimer.current)
          }
        },
        [runtime]
      )
      const frame = data !== null && data !== undefined && data.phase === 'ready' && typeof data.frame === 'string' ? data.frame : null
      React.useEffect(
        function () {
          return function () {
            if (frame !== null) {
              try {
                URL.revokeObjectURL(frame)
              } catch (_error) {
                /* already revoked */
              }
            }
          }
        },
        [frame]
      )
      // Native leave listeners on the card element itself, on top of the React
      // handlers: pointerleave/mouseleave are the last-resort "user left" signal.
      React.useEffect(
        function () {
          const card = cardRef.current
          if (card === null || card === undefined || typeof card.addEventListener !== 'function') return
          const leave = function () {
            runtime.armClose()
          }
          card.addEventListener('pointerleave', leave)
          card.addEventListener('mouseleave', leave)
          return function () {
            card.removeEventListener('pointerleave', leave)
            card.removeEventListener('mouseleave', leave)
          }
        },
        [runtime]
      )
      React.useLayoutEffect(
        function () {
          const card = cardRef.current
          if (card === null) return
          const width = card.offsetWidth
          const height = card.offsetHeight
          if (width <= 0 || height <= 0) return
          let dx = 0
          let dy = 0
          if (placement.left + width > window.innerWidth - VIEWPORT_MARGIN) {
            dx = window.innerWidth - VIEWPORT_MARGIN - (placement.left + width)
          }
          if (placement.left + dx < VIEWPORT_MARGIN) dx = VIEWPORT_MARGIN - placement.left
          if (placement.top + height > window.innerHeight - VIEWPORT_MARGIN) {
            dy = window.innerHeight - VIEWPORT_MARGIN - (placement.top + height)
          }
          if (placement.top + dy < VIEWPORT_MARGIN) dy = VIEWPORT_MARGIN - placement.top
          setOffset(function (current) {
            return current.x === dx && current.y === dy ? current : { x: dx, y: dy }
          })
        },
        [placement, data, state.mode]
      )

      const flashMessage = function (result) {
        if (result === null || result === undefined || typeof result.toast !== 'string') return
        setFlash({ key: result.toast, error: result.tone === 'error' })
        if (flashTimer.current !== 0) window.clearTimeout(flashTimer.current)
        flashTimer.current = window.setTimeout(function () {
          flashTimer.current = 0
          setFlash(null)
        }, 1600)
      }

      const meta = data !== null && data !== undefined && data.phase === 'ready' && data.meta !== null && data.meta !== undefined ? data.meta : null
      const name =
        meta !== null
          ? meta.name
          : typeof descriptor.name === 'string' && descriptor.name !== ''
            ? descriptor.name
            : pathBasename(typeof descriptor.path === 'string' ? descriptor.path : '')
      const extension = meta !== null && typeof meta.ext === 'string' && meta.ext !== '' ? meta.ext : pathExtension(descriptor.path || '')
      const badgeText = (extension !== '' ? extension : t('header.badgeFile')).toUpperCase().slice(0, 8)
      const sub = []
      if (meta !== null && Number.isFinite(meta.size)) sub.push(runtime.formatBytes(meta.size))
      if (meta !== null && Number.isFinite(meta.mtimeMs)) sub.push(runtime.formatDate(meta.mtimeMs))
      const absolute = meta !== null && typeof meta.absPath === 'string' ? meta.absPath : isAbsolutePath(descriptor.path) ? descriptor.path : undefined
      const copyPath = absolute !== undefined ? absolute : typeof descriptor.path === 'string' ? descriptor.path : ''
      /** Action target of the card, shaped like the modal's buildPerformTarget. */
      const peekTarget = {
        path: absolute,
        displayPath: copyPath === '' ? undefined : copyPath,
        name: name,
        meta: meta !== null ? meta : typeof data.image === 'string' && data.image !== '' ? { preview: 'image' } : null,
        src: descriptor.kind === 'image-src' ? descriptor.src : undefined
      }
      const lineCount = data !== null && data !== undefined && typeof data.text === 'string' ? data.text.split('\n').length : 0
      const complete =
        data !== null &&
        data !== undefined &&
        data.phase === 'ready' &&
        ((typeof data.image === 'string' && data.image !== '') ||
          (typeof data.text === 'string' && data.truncated !== true && lineCount <= PEEK_TEXT_LINES))
      // Metadata-only (pdf/office/unknown), truncated text, errors and "more"
      // lines all leave the peek incomplete; only then the full-preview line is
      // rendered, so it is never a dead control.
      const incomplete = data !== null && data !== undefined && data.phase !== 'loading' && complete !== true
      const debugEnabled = runtime.debugEnabled()
      const debug = debugEnabled === true ? runtime.debug() : null

      const peekBody = function () {
        try {
          if (data === null || data === undefined) return null
          if (data.phase === 'loading') return h('div', { className: 'dfp-peek-hint' }, t('hover.loading'))
          if (data.phase === 'hostMissing') return h('div', { className: 'dfp-peek-hint' }, t('state.restartTitle'))
          if (data.phase === 'error' || data.phase === 'nameOnly' || data.phase === 'aborted') {
            return h('div', { className: 'dfp-peek-hint' }, t('hover.error'))
          }
          if (typeof data.image === 'string' && data.image !== '') {
            return h(
              'div',
              { className: 'dfp-peek-media' },
              h('img', { src: data.image, alt: t('viewer.imageAlt', { name: name }), loading: 'lazy' })
            )
          }
          if (data.tooLarge === true) return h('div', { className: 'dfp-peek-hint' }, t('hover.imageTooLarge'))
          if (data.failed === true) return h('div', { className: 'dfp-peek-hint' }, t('hover.error'))
          if (frame !== null) return h('iframe', { className: 'dfp-peek-frame', src: frame, title: t('viewer.iframe') })
          if (typeof data.text === 'string') {
            const lines = data.text.split('\n').slice(0, PEEK_TEXT_LINES)
            return h(
              'div',
              { className: 'dfp-peek-lines' },
              lines.map(function (line, index) {
                return h('div', { className: 'dfp-peek-line', key: 'pl' + String(index) }, line === '' ? '\u00a0' : line)
              })
            )
          }
          if (meta !== null && meta.preview === 'office') return h('div', { className: 'dfp-peek-hint' }, t('hover.officeHint'))
          if (meta !== null && meta.preview === 'pdf') return h('div', { className: 'dfp-peek-hint' }, t('hover.documentHint'))
          return h('div', { className: 'dfp-peek-hint' }, t('hover.metaOnly'))
        } catch (_error) {
          return h('div', { className: 'dfp-peek-hint' }, t('hover.error'))
        }
      }

      return h(
        'div',
        {
          className: 'dfp-peek',
          'data-dsh-file-preview-peek': '',
          'data-mode': state.mode,
          'data-closing': state.closing === true ? 'true' : 'false',
          ref: setCard,
          role: 'dialog',
          'aria-label': name,
          style: {
            left: String(placement.left) + 'px',
            top: String(placement.top) + 'px',
            width: String(placement.width) + 'px',
            maxHeight: String(placement.heightLimit) + 'px',
            transform: 'translate3d(' + String(offset.x) + 'px,' + String(offset.y) + 'px,0)'
          },
          onPointerEnter: function () {
            runtime.keepPeek()
          },
          onPointerLeave: function () {
            runtime.armClose()
          },
          onMouseLeave: function () {
            runtime.armClose()
          }
        },
        h(
          'div',
          { className: 'dfp-peek-head' },
          h('span', { className: 'dfp-peek-badge' }, badgeText),
          h(
            'div',
            { className: 'dfp-peek-heading' },
            h('div', { className: 'dfp-peek-name', title: name }, middleTruncate(name, 30, 12)),
            sub.length === 0 ? null : h('div', { className: 'dfp-peek-sub' }, sub.join(' · '))
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dfp-peek-close',
              title: t('dialog.closeTitle'),
              'aria-label': t('peek.close'),
              onClick: function () {
                runtime.dismissPeek('close')
              }
            },
            h(Icon, { name: 'close', size: 12 })
          )
        ),
        h(
          'div',
          { className: 'dfp-peek-body' },
          peekBody(),
          incomplete === true
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dfp-peek-more',
                  onClick: function () {
                    runtime.openPreview(descriptor, descriptor.sourceEl)
                  }
                },
                t('hover.more')
              )
            : null
        ),
        h(
          'div',
          { className: 'dfp-peek-foot' },
          h(
            'button',
            {
              type: 'button',
              className: 'dfp-peek-action',
              title: t('hover.open'),
              'aria-label': t('hover.open'),
              onClick: function () {
                runtime.openPreview(descriptor, descriptor.sourceEl)
              }
            },
            h(Icon, { name: 'open', size: 14 })
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dfp-peek-action',
              title: t('hover.reveal'),
              'aria-label': t('hover.reveal'),
              disabled: absolute === undefined,
              onClick: function () {
                Promise.resolve(runtime.perform('reveal', { path: absolute })).then(flashMessage)
              }
            },
            h(Icon, { name: 'folder', size: 14 })
          ),
          h(CopyControl, {
            runtime: runtime,
            compact: true,
            target: peekTarget,
            mainKey: 'path',
            onRun: function (key) {
              Promise.resolve(runtime.perform(key === 'copy' ? 'copy-path' : key, peekTarget)).then(flashMessage)
            }
          }),
          flash === null
            ? null
            : h(
                'span',
                { className: 'dfp-peek-flash', role: 'status', 'aria-live': 'polite', style: flash.error === true ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined },
                t(flash.key)
              ),
          debug === null
            ? null
            : h(
                'span',
                { className: 'dfp-peek-debug', title: 'open:dismiss:source:store:watchdog' },
                String(debug.open) +
                  ':' +
                  String(debug.dismiss) +
                  ':' +
                  debug.lastSource +
                  ':' +
                  debug.storeState +
                  ':' +
                  (debug.watchdogArmed === true ? 'wd' : '-')
              )
        )
      )
    }
    //#endregion

    //#region Host, boundary and seat
    /** The plugin's single fixed root: the modal, the hover card and the CSS. */
    function OverlayHost(props) {
      const runtime = props.runtime
      const overlay = useStore(runtime.overlayStore)
      const peek = useStore(runtime.peekStore)
      const setRoot = React.useCallback(
        function (node) {
          runtime.setRoot(node)
        },
        [runtime]
      )
      React.useEffect(
        function () {
          return function () {
            runtime.setRoot(null)
          }
        },
        [runtime]
      )
      return h(
        'div',
        { className: 'dfp-root', 'data-dsh-file-preview-root': '', ref: setRoot },
        h('style', null, CSS),
        peek === null ? null : h(HoverPeek, { runtime: runtime, state: peek, key: peek.key + ':' + String(peek.nonce) }),
        overlay === null ? null : h(PreviewModal, { runtime: runtime, state: overlay, key: String(overlay.token) })
      )
    }

    /**
     * Keeps a crash inside the plugin: React unmounts a subtree whose render
     * throws, which would blank the slot entry. This boundary renders a small
     * dismissable card instead.
     */
    class OverlayErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
        this.reset = this.reset.bind(this)
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        try {
          console.error('[dsh-file-preview] overlay crashed:', error)
        } catch (_error) {
          /* console can be unavailable in locked-down pages */
        }
      }

      reset() {
        this.setState({ failed: false })
      }

      render() {
        if (this.state.failed !== true) return this.props.children
        const runtime = this.props.runtime
        return h(
          'div',
          { className: 'dfp-root', 'data-dsh-file-preview-root': '', 'data-failed': 'true' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'dfp-modal-root' },
            h('div', { className: 'dfp-mask', 'aria-hidden': 'true' }),
            h(
              'div',
              { className: 'dfp-panel dfp-panel-error', role: 'dialog', 'aria-modal': 'true' },
              h(
                'div',
                { className: 'dfp-state', 'data-tone': 'error' },
                h('span', { className: 'dfp-state-icon' }, h(Icon, { name: 'alert' })),
                h(
                  'div',
                  { className: 'dfp-state-text' },
                  h('div', { className: 'dfp-state-title' }, runtime.t('error.boundaryTitle')),
                  h('div', { className: 'dfp-state-body' }, runtime.t('error.boundaryBody'))
                ),
                h('button', { type: 'button', className: 'dfp-state-action', onClick: this.reset }, runtime.t('error.boundaryClose'))
              )
            )
          )
        )
      }
    }

    /** The `shell.overlay` occupant: boundary plus the fixed plugin root. */
    function OverlaySeat(props) {
      const runtime = props.runtime
      return h(OverlayErrorBoundary, { runtime: runtime }, h(OverlayHost, { runtime: runtime }))
    }
    //#endregion

    return {
      inject: inject,
      apply: apply
    }
  }
})
