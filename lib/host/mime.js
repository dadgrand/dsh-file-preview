/**
 * Extension classification for the file-preview host half.
 *
 * One table answers the three questions every route asks about a name:
 * the media type served by `/raw`, the preview kind reported by `/meta`, and
 * whether the file is one of the six Office formats the shipped converter
 * accepts. Pure data + string helpers: no filesystem access, no I/O.
 *
 * @module dsh-file-preview/host/mime
 */

/** Extensionless filenames that are plain text (README, LICENSE, ...). */
const TEXT_NAMES = new Set([
  'readme', 'license', 'licence', 'changelog', 'notice', 'authors', 'copying',
  'makefile', 'dockerfile', 'procfile', 'gemfile', 'rakefile', 'vagrantfile',
])

/** extension (with dot, lower case) -> media type. */
const MIME_TYPES = new Map(Object.entries({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdx': 'text/markdown',
  '.rst': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.jsonc': 'application/json',
  '.ndjson': 'application/x-ndjson',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xhtml': 'application/xhtml+xml',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.env': 'text/plain',
  '.properties': 'text/plain',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.jsx': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.css': 'text/css',
  '.scss': 'text/x-scss',
  '.less': 'text/x-less',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.kt': 'text/x-kotlin',
  '.kts': 'text/x-kotlin',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cc': 'text/x-c++',
  '.cpp': 'text/x-c++',
  '.hpp': 'text/x-c++',
  '.cs': 'text/x-csharp',
  '.php': 'text/x-php',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript',
  '.fish': 'text/x-shellscript',
  '.ps1': 'text/x-powershell',
  '.psm1': 'text/x-powershell',
  '.bat': 'text/plain',
  '.cmd': 'text/plain',
  '.sql': 'text/x-sql',
  '.graphql': 'text/plain',
  '.gql': 'text/plain',
  '.proto': 'text/plain',
  '.lua': 'text/x-lua',
  '.swift': 'text/x-swift',
  '.dart': 'text/x-dart',
  '.r': 'text/x-r',
  '.pl': 'text/x-perl',
  '.ex': 'text/x-elixir',
  '.exs': 'text/x-elixir',
  '.erl': 'text/x-erlang',
  '.hs': 'text/x-haskell',
  '.clj': 'text/x-clojure',
  '.scala': 'text/x-scala',
  '.gradle': 'text/plain',
  '.vue': 'text/plain',
  '.svelte': 'text/plain',
  '.astro': 'text/plain',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.rtf': 'application/rtf',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg',
  '.wmv': 'video/x-ms-wmv',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
}))

/** Extensions the shipped `officeToPdf` service accepts, without the dot. */
export const OFFICE_EXTENSIONS = Object.freeze(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])

/** Preview kinds the client half understands. */
const PREVIEW_BY_EXTENSION = new Map()
for (const ext of ['.png', '.jpg', '.jpeg', '.jfif', '.gif', '.webp', '.avif', '.bmp', '.ico', '.svg', '.tif', '.tiff']) {
  PREVIEW_BY_EXTENSION.set(ext, 'image')
}
PREVIEW_BY_EXTENSION.set('.pdf', 'pdf')
for (const ext of ['.md', '.markdown', '.mdx']) PREVIEW_BY_EXTENSION.set(ext, 'markdown')
for (const ext of ['.html', '.htm', '.xhtml']) PREVIEW_BY_EXTENSION.set(ext, 'html')
for (const ext of ['.txt', '.text', '.log', '.rst', '.csv', '.tsv', '.ini', '.cfg', '.conf', '.env', '.properties']) {
  PREVIEW_BY_EXTENSION.set(ext, 'text')
}
const CODE_EXTENSIONS = [
  '.json', '.jsonc', '.ndjson', '.xml', '.yaml', '.yml', '.toml', '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.tsx', '.css', '.scss', '.less', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.psm1', '.bat', '.cmd', '.sql', '.graphql', '.gql', '.proto', '.lua', '.swift', '.dart', '.r',
  '.pl', '.ex', '.exs', '.erl', '.hs', '.clj', '.scala', '.gradle', '.vue', '.svelte', '.astro',
]
for (const ext of CODE_EXTENSIONS) PREVIEW_BY_EXTENSION.set(ext, 'code')
for (const ext of OFFICE_EXTENSIONS) PREVIEW_BY_EXTENSION.set('.' + ext, 'office')
for (const ext of ['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.ogv', '.wmv']) {
  PREVIEW_BY_EXTENSION.set(ext, 'video')
}
for (const ext of ['.mp3', '.m4a', '.wav', '.ogg', '.oga', '.opus', '.flac', '.aac', '.wma']) {
  PREVIEW_BY_EXTENSION.set(ext, 'audio')
}

/**
 * Lower-case extension including the leading dot ('' when there is none).
 * @param {string} name - file name or path.
 * @returns {string} extension, e.g. `.png`.
 */
export function extensionOf(name) {
  if (typeof name !== 'string') return ''
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  if (dot < 0 || dot === base.length - 1) return ''
  return base.slice(dot).toLowerCase()
}

/**
 * Media type for one extension; `application/octet-stream` when unknown.
 * Dotfiles such as `.env` or `.gitignore` are configuration text.
 * @param {string} ext - lower-case extension with dot.
 * @returns {string} media type.
 */
export function mimeFor(ext) {
  const known = MIME_TYPES.get(ext)
  if (known !== undefined) return known
  if (typeof ext === 'string' && ext.startsWith('.') && ext.indexOf('.', 1) === -1) return 'text/plain'
  return 'application/octet-stream'
}

/**
 * Whether a media type is textual (a charset parameter is appropriate).
 * @param {string} mime - media type.
 * @returns {boolean} true for text/*, JSON, XML, YAML, JavaScript, SVG.
 */
export function isTextualMime(mime) {
  return typeof mime === 'string' && (
    mime.startsWith('text/')
    || mime === 'application/json'
    || mime === 'application/xml'
    || mime === 'application/xhtml+xml'
    || mime === 'application/yaml'
    || mime === 'application/toml'
    || mime === 'application/x-ndjson'
    || mime === 'image/svg+xml'
  )
}

/**
 * Content type header value: textual types get `charset=utf-8`.
 * @param {string} ext - lower-case extension with dot.
 * @returns {string} value for `content-type`.
 */
export function contentTypeFor(ext) {
  const mime = mimeFor(ext)
  return isTextualMime(mime) ? `${mime}; charset=utf-8` : mime
}

/**
 * Preview kind for one name: image|pdf|text|markdown|code|html|office|video|audio|none.
 * @param {string} name - file name or path.
 * @returns {string} preview kind.
 */
export function previewKind(name) {
  const ext = extensionOf(name)
  if (ext === '') {
    const base = String(name).slice(Math.max(String(name).lastIndexOf('/'), String(name).lastIndexOf('\\')) + 1).toLowerCase()
    return TEXT_NAMES.has(base) ? 'text' : 'none'
  }
  const known = PREVIEW_BY_EXTENSION.get(ext)
  if (known !== undefined) return known
  // A dotfile (`.env`, `.gitignore`, `.npmrc`) is configuration text.
  return ext.startsWith('.') && ext.indexOf('.', 1) === -1 ? 'text' : 'none'
}

/**
 * Office extension without the dot when the shipped converter accepts it.
 * @param {string} ext - lower-case extension with dot.
 * @returns {string|null} `docx`, `xlsx`, ... or null.
 */
export function officeExtensionFor(ext) {
  const bare = typeof ext === 'string' ? ext.replace(/^\./, '').toLowerCase() : ''
  return OFFICE_EXTENSIONS.includes(bare) ? bare : null
}

/**
 * Preview kinds whose bytes are never text.
 * @param {string} kind - preview kind from {@link previewKind}.
 * @returns {boolean} true for image/pdf/office/video/audio.
 */
export function isBinaryPreviewKind(kind) {
  return kind === 'image' || kind === 'pdf' || kind === 'office' || kind === 'video' || kind === 'audio'
}
