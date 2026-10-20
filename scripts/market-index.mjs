// Generate plugin-market.json (format 1) and validate it with the shipped validator.
// Usage: node scripts/market-index.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const timestamp = Math.floor(Date.now() / 1000)

// The published package installs from the npm registry by default; `--git`
// emits the commit-pinned git source instead (same bytes for consumers without
// registry access).
const useGit = process.argv.includes('--git')
const versionSource = useGit
  ? { type: 'git', url: 'https://github.com/dadgrand/dsh-file-preview', commit }
  : { type: 'npm' }

const index = {
  format: 1,
  title: { en: "dadgrand's DSH plugins", ru: 'Плагины dadgrand для DSH' },
  description: {
    en: 'Plugins for the DeepSeek Harness Web UI.',
    ru: 'Плагины для веб-интерфейса DeepSeek Harness.',
  },
  metadata: {
    categories: { ui: { title: { en: 'Interface', ru: 'Интерфейс' } } },
    labels: {},
    sortKeys: {},
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'File Preview', ru: 'Просмотр файлов' },
      description: {
        en: 'In-chat preview modal for local files, images, PDFs, Office documents and website links, with a hover peek, copy actions (path / contents / file) and open-in-browser / reveal-in-folder / default-app actions.',
        ru: 'Всплывающий предпросмотр файлов, картинок, PDF, документов Office и ссылок прямо в чате: hover-карточка, копирование (путь / содержимое / файл), открытие в браузере, проводнике и приложении по умолчанию.',
      },
      icon: 'https://raw.githubusercontent.com/dadgrand/dsh-file-preview/main/icon.svg',
      author: pkg.author,
      homepage: pkg.homepage,
      repository: { url: 'https://github.com/dadgrand/dsh-file-preview' },
      metadata: { category: 'ui', keywords: ['preview', 'pdf', 'office', 'markdown', 'hover'] },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: timestamp,
          source: versionSource,
          engines: { dsh: pkg.dsh.engines.dsh },
        },
      ],
    },
  ],
}

const out = join(root, 'plugin-market.json')
writeFileSync(out, JSON.stringify(index, null, 2) + '\n', 'utf8')

const validatorPath = process.env.DSH_MARKET_VALIDATOR
if (validatorPath === undefined || validatorPath === '') {
  console.log('wrote plugin-market.json; set DSH_MARKET_VALIDATOR to validate')
  process.exit(0)
}
const { parseMarketIndex, marketInstallTarget } = await import(pathToFileURL(validatorPath).href)
const parsed = parseMarketIndex(JSON.parse(readFileSync(out, 'utf8')), 'https://raw.githubusercontent.com/dadgrand/dsh-file-preview/main/plugin-market.json')
const target = marketInstallTarget(parsed.plugins[0].name, parsed.plugins[0].versions[0])
console.log('VALID index; plugins=' + String(parsed.plugins.length) + ' version=' + parsed.plugins[0].versions[0].version)
console.log('install spec: ' + target.spec)
