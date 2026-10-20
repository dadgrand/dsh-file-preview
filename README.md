# dsh-file-preview

Плагин DSH, который открывает файлы, картинки, PDF, документы Office и ссылки
прямо в чате: по клику на путь или ссылку поверх переписки появляется аккуратное
модальное окно с предпросмотром и действиями «скопировать», «открыть в браузере»,
«показать в проводнике», «открыть в приложении по умолчанию».

Плагин состоит из двух половин:

- **host** (`index.js` + `lib/host/`) — регистрирует HTTP-маршруты
  `/api/dsh-file-preview/*` на `webServer` DSH, читает файлы с диска,
  конвертирует Office в PDF, тянет метаданные ссылок и выполняет системные
  действия;
- **client** (`lib/client.js`) — перехватывает клики в чате, рисует модалку,
  копирует текст через clipboard браузера.

Пакетный скелет и host-половина собраны в задаче H1; клиентская половина
написана параллельной задачей client-dev и уже лежит в `lib/client.js`.
Манифест ссылается на неё через `exports["./client"]`.

## Что важно знать сразу

- **Electron в Host недоступен.** Desktop Host — это дочерний процесс
  Electron-бинарника, запущенный с `ELECTRON_RUN_AS_NODE=1`: `require('electron')`
  падает с `MODULE_NOT_FOUND`, а ESM-неймспейс пуст (нет `shell` и `clipboard`).
  Поэтому открытие/показ и файловый буфер выполняются запуском системных
  команд (как в `dsh-host-open-in-app`); текст/картинку в буфер копирует клиент.
- **Нет сборщика, TypeScript и npm-зависимостей.** Host — обычный ESM, только
  `node:*` и относительные импорты. Клиентский бандл собирает client-dev.
- **Ничего не пишется вне `$DSH_HOME/cache/file-preview/`** (кэш PDF).

## Маршруты

База: `/api/dsh-file-preview`. Все маршруты отвечают только loopback-клиенту
(см. «Замок безопасности»).

| Метод и путь | Что отдаёт |
|---|---|
| `GET /meta?path=&cwd=` | `{ok:true,path,absPath,name,ext,kind,mime,size,mtimeMs,preview,officeExt?,canRead,reason?}`. `preview`: `image\|pdf\|text\|markdown\|code\|html\|office\|video\|audio\|none`. Ошибки: `400 bad-path`, `403 outside-allowed-roots`, `404 not-found`. |
| `GET /raw?path=&download=0\|1` | байты файла; `Range` → `206` + `content-range`, иначе `200`; `content-type`, `content-length`, `accept-ranges`, `content-disposition: inline/attachment; filename*=UTF-8''…`, `cache-control: private, max-age=30`, `x-content-type-options: nosniff`. |
| `GET /text?path=&maxBytes=` | `{ok:true,text,truncated,encoding,bytes}`; бинарное содержимое — `{ok:false,code:'binary'}` с HTTP 200. UTF-8, при «битых» байтах — fallback Windows-1251. |
| `GET /office-pdf?path=` | `application/pdf` через сервис `officeToPdf`; не-Office расширение — `415 {code:'not-office'}`, сервис не смонтирован — `501 {code:'office-unavailable'}`. |
| `GET /link?url=<http(s)>` | `{ok:true,url,host,title?,description?,siteName?,icon?,image?,error?}`; таймаут 5 с, не больше 512 КиБ тела, http(s) только, не бросает исключений. |
| `GET /resolve?name=<basename>&cwd=` | `{ok:true,path,absPath,name,size,mtimeMs}` — совпадение по имени в `$DSH_HOME/attachments` (приоритетный корень), иначе в `cwd`; самый свежий по `mtimeMs` внутри выбранного корня; `404 not-found` или `409 ambiguous` (несколько одинаково свежих). |
| `POST /action` | тело `{action, path?\|url?}`, `action` ∈ `open\|reveal\|browser\|copy-file` → `{ok:true}` либо `{ok:false,code,message}`. |
| `GET /status` | `{ok:true,version,startedAt,requests:{meta,raw,text,office,link,action,resolve},lastError,lastClientSeat}`. |

`POST /action` требует `content-type: application/json`; иначе `415`.
Текстовые/картиночные «копировать» действия в хосте отсутствуют: этот clipboard
целиком на клиенте. Отдельный `copy-file` кладёт **сам файл** на системный
clipboard.

### Действия ОС (`/action`)

| Действие | Windows | macOS | Linux |
|---|---|---|---|
| `open` | `explorer.exe <file URI>` | `open <path>` | `xdg-open <path>` |
| `reveal` | `explorer.exe /select,<file URI>` | `open -R <path>` | `xdg-open <dir>` |
| `browser` | `rundll32.exe url.dll,FileProtocolHandler <url>` | `open <url>` | `xdg-open <url>` |
| `copy-file` | фиксированный PowerShell-скрипт с `System.Windows.Forms.Clipboard.SetFileDropList` (STA) | фиксированный `osascript` с POSIX file reference | `501 action-unavailable` |

`copy-file` передаёт путь **отдельным argv-элементом**, а не вставляет его в
текст скрипта; лаунчер запускается без shell, ждёт завершения с коротким
settle-таймаутом (3 с) и по коду выхода отвечает `{ok:true}` либо
`{ok:false, code:'copy-file-failed', message}` с кодом в сообщении. На Windows
файл попадает в clipboard как file-drop list (вставляется в Explorer и почтовые
клиенты); на macOS — как POSIX file reference. На Linux портируемого
file-drop clipboard нет, поэтому платформа честно отвечает `action-unavailable`
(текстовый clipboard клиента при этом работает).

### `/resolve` — зачем он нужен

Карточка пользовательского вложения в DOM содержит только отображаемое имя
файла: ни пути, ни attachment id (см. `.research/file-preview/findings.md` §3c,
§4.2). Поэтому по имени ищется файл с явным приоритетом корней:

1. **`$DSH_HOME/attachments`** — хранилище вложений. Если там есть хотя бы одно
   совпадение по basename, ответ берётся **только** из этого корня: самый свежий
   по `mtimeMs`. Более новый одноимённый файл в workspace на результат не влияет —
   пользователь кликнул именно вложение.
2. **`cwd` запроса** — запасной корень. Сканируется только если в
   `$DSH_HOME/attachments` совпадений нет; выбор и правило ничьей те же.

Поиск ограничен глубиной (`resolveMaxDepth`) и общим количеством просмотренных
записей (`resolveMaxEntries`); символические ссылки пропускаются. Если внутри
выбранного корня несколько файлов имеют одинаковый самый свежий `mtimeMs`,
маршрут честно отвечает `409 ambiguous` с кандидатами, а не выбирает случайный.

## Замок безопасности (fence)

Каждый маршрут проходит одну проверку:

1. `req.socket.remoteAddress` — loopback (`127/8`, `::1`, IPv4-mapped `127/8`);
2. заголовок `Host` — loopback-хост (`localhost`, `127/8`, `[::1]`) — защита от
   DNS rebinding;
3. `sec-fetch-site`, если он есть, — только `same-origin`, `same-site` или
   `none`;
4. `Origin`, если он есть, совпадает с `Host`;
5. для `POST` — `application/json`.

Кросс-сайтовый запрос получает `403` с JSON `{ok:false,code:'forbidden'}`.
Если в композиции смонтирован сервис `connection`, дополнительно вызывается
`connection.requestRejection(req)` — как в `dsh-host-open-in-app`.
Тела POST ограничены 64 КиБ; JSON-ответы уходят с `cache-control: no-store` и
`x-content-type-options: nosniff`.

### Что плагин защищает и что разрешает

Защита (не зависит от `readScope`): плагин не отдаёт файлы удалённым страницам,
не поддаётся DNS rebinding (проверка `Host`), отклоняет кросс-сайтовые запросы
(`sec-fetch-site`/`Origin`), не пускает неаутентифицированного вызывающего
(loopback + `connection.requestRejection`, если сервис смонтирован), требует
JSON для POST; вызывающего он не перенаправляет (редиректы источника для
`/link` остаются в пределах http(s)).

При этом в desktop-сценарии это **страница самого владельца**: по умолчанию
(`readScope: any`) его клик по ссылке в чате должен открывать предпросмотр
**любого существующего файла на этой машине** — в том числе вне cwd сессии,
`$DSH_HOME`, домашнего каталога и temp (`D:\Work\...`, подключённый диск,
существующий UNC-путь). Это осознанное разрешение, а не дыра: запрос всё равно
приходит только из loopback-окна DSH после проверок выше.

Строгий режим включается явно:

```yaml
config:
  readScope: roots
  allowRoots: ['D:/projects', '\\\\server\\share']
```

`readScope: roots` возвращает allow-list: реальный путь обязан лежать внутри
cwd запроса, `$DSH_HOME`, `os.homedir()`, `os.tmpdir()` или `allowRoots`;
иначе — `403 {code:'outside-allowed-roots'}`.

## Пути и разрешённые корни

Вход `path` может быть:

- абсолютным или относительным — относительный считается от `cwd` из query, а
  без него — от `process.cwd()` Host-процесса;
- с `~` в начале (`~/file.txt`);
- в кавычках или бэктиках (`"file.txt"`);
- `file://`-URL (`file:///C:/dir/file.txt`).

По умолчанию (`readScope: any`) читающие маршруты (`/meta`, `/raw`, `/text`,
`/office-pdf`, `/resolve`) принимают любой **существующий** путь; отсутствующий
файл по-прежнему даёт `404 not-found`. Символические ссылки разрешаются через
`realpath`, поэтому в строгом режиме ссылка не может вывести за корень.

В режиме `readScope: roots` включается прежний allow-list — **реальный** путь
обязан лежать внутри одного из корней:

- `cwd` запроса;
- `$DSH_HOME` (по умолчанию `~/.dsh`);
- `os.homedir()`;
- `os.tmpdir()`;
- плюс `Config.allowRoots`.

Перед сравнением путь проходит `realpath` (для ещё не существующего файла
разрешается ближайший существующий предок). На Windows сравнение
регистронезависимое. Управляющие символы и NUL в пути отклоняются с `400
bad-path` в обоих режимах. `/action` пользовательский и всегда принимает любой
существующий путь без проверки корней.

## Config (поле `config` у строки `file-preview`)

```yaml
- insert:
    - id: file-preview
      name: 'dsh-file-preview'
      config:
        readScope: any
        allowRoots: ['D:/projects', '\\\\server\\share']
        officeTimeoutMs: 120000
        copyFileTimeoutMs: 3000
        linkTimeoutMs: 5000
        linkMaxBytes: 524288
        resolveMaxDepth: 8
        resolveMaxEntries: 20000
```

| Ключ | По умолчанию | Смысл |
|---|---|---|
| `readScope` | `'any'` | `'any'` — читать любой существующий путь; `'roots'` — строгий allow-list |
| `allowRoots` | `[]` | дополнительные корни для `readScope: roots` |
| `officeTimeoutMs` | `120000` | бюджет конвертации Office → PDF |
| `copyFileTimeoutMs` | `3000` | сколько ждать clipboard-лаунчер `copy-file` до ответа |
| `linkTimeoutMs` | `5000` | таймаут загрузки метаданных ссылки |
| `linkMaxBytes` | `524288` | максимум тела страницы для `/link` |
| `resolveMaxDepth` | `8` | глубина поиска `/resolve` |
| `resolveMaxEntries` | `20000` | сколько записей просматривать в `/resolve` |

`Config`-схема не экспортируется намеренно (не хотим тянуть `schemastery` в
пакет): неизвестные/битые значения игнорируются и заменяются значениями по
умолчанию.

## Office → PDF и кэш

Если в композиции есть сервис `officeToPdf` (в desktop-профиле это строка
`office-to-pdf`), host вызывает его лениво на каждый запрос:

```js
convert({
  extension: 'docx',                 // doc|docx|xls|xlsx|ppt|pptx
  priority: 'foreground',
  source: { key, version, bytes, read(signal, maxBytes) },
}, signal)
```

Сконвертированные PDF кэшируются в
`$DSH_HOME/cache/file-preview/<sha256(absPath+mtimeMs+size)>.pdf`. Запись
атомарная (tmp + rename), кэш best-effort: если каталог только для чтения,
предпросмотр всё равно работает. Изменённый файл автоматически получает новый
ключ. Старые PDF автоматически не удаляются — каталог можно чистить вручную.

Если сервиса нет, маршрут отвечает `501 office-unavailable` — клиент показывает
карточку «открыть в приложении».

## Открытие из чата (как это устроено)

Клиентская половина ставит capture-фазный `click`-листенер на `window` и
перехватывает случаи, которые описаны в исследовании:

- ссылка на локальный путь в markdown — `button` с классом `fileLink` и путём в
  `title`/тексте;
- картинка ассистента — `img[src*="api/file?path="]`, путь берётся из
  `searchParams.get('path')`;
- карточка deliverable — `[data-presented-file] button[title]` (абсолютный путь);
- изменённый файл — `[data-changed-files] button[aria-describedby]` и скрытый
  `span` с абсолютным путём;
- внешняя ссылка — `a[href^="http"]`;
- вложение пользователя — `[data-message-attachments] span[title]`: только имя,
  поэтому клиент зовёт `/resolve`.

После перехвата клиент открывает модалку и общается только с host-маршрутами
выше. Никаких правок в чужих пакетах и профиле для этого не требуется.

## Проверка

```bash
cd plugins/dsh-file-preview
node --check index.js
node scripts/check-bundle.mjs   # манифест, патч, иконка, README, node --check
node scripts/unit-host.mjs      # реальный loopback-сервер + заглушки
```

`unit-host.mjs` поднимает настоящий `node:http` на эфемерном порту и проверяет:
`/meta` для png/pdf/md/docx/txt, `/raw` (тип, длина, `Range` → 206,
`content-disposition`, HEAD), `/text` (md/txt, `binary`, Windows-1251,
`maxBytes`), `/office-pdf` (конвертация, кэш, `415`, `501`), fence (`403` на
cross-site/чужой Origin/Host), `400/404`, `/action` с заглушкой лаунчера
(точные команды `explorer.exe` / `rundll32.exe`), `/link` с заглушкой `fetch`,
`/resolve` (`not-found`, `ambiguous`), `/action` с заглушкой лаунчера
(точные команды `explorer.exe` / `rundll32.exe`, argv для `copy-file` на
win32/darwin, `action-unavailable` на Linux) и счётчики `/status`.

## `/status` и канал `?seat=`

Клиентская половина добавляет `?seat=<state>` к любому GET (например,
`seat=overlay-mounted`, `seat=no-slot`, `seat=error:…`). Host запоминает
последнее значение (до 80 символов) и отдаёт его в `/status.lastClientSeat` —
это единственный способ снаружи доказать, что бандл действительно смонтировался
в браузере, а не просто лежит в профиле.

Счётчики `requests` увеличиваются на каждый вход в маршрут; `lastError`
хранит последнюю ошибку `{route, code, message, at}`. Перезапуск Host-процесса
(или перезагрузка плагина) обнуляет счётчики.

## Установка, включение и откат

Установка — только через Plugin Manager DSH (`install_bundle` с абсолютным
путём к `plugins/dsh-file-preview`); вручную профиль не редактируется. После
установки в профиле появляются:

- `package.json` → `dependencies["dsh-file-preview"] = "link:<path>"`;
- `dsh.profile.bundles` включает `dsh-file-preview`;
- строка `file-preview` в дереве Cordis.

Включение/выключение — тумблер строки `file-preview` в Plugin Manager (или
`set_plugin`/`set_bundle`). Host-ESM подхватывается только после перезапуска
Host-процесса; клиентский бандл — после перезагрузки страницы (HMR, если
запущен watcher).

Откат: выключить строку `file-preview`, затем `remove_bundle` для
`dsh-file-preview`. Профиль и остальные пакеты при этом не меняются. Кэш PDF
лежит отдельно в `$DSH_HOME/cache/file-preview/` и удаляется вручную.

## Ограничения

- Windows — первый приоритет; macOS/Linux поддержаны конструктивно:
  `node:path`, таблица лаунчеров `open`/`xdg-open`, никаких предположений о
  буквах дисков в логике.
- Копирование текста/картинки/ссылки в буфер обмена — на клиенте
  (`navigator.clipboard` / `writeClipboard`); `copy-file` (сам файл) выполняет
  host через системный file-drop clipboard там, где он есть (Windows/macOS).
- `copy-file` на Linux отвечает `action-unavailable`: портируемого API
  file-drop clipboard в Linux нет, а `xclip`/`xsel` не гарантируют file list.
- WSL-специфичный перевод путей не реализован (в отличие от
  `dsh-native-command`); на обычном Linux используется `xdg-open`.
- Страницы `/link` парсятся регулярными выражениями, а не полноценным
  HTML-парсером: этого достаточно для title/description/og-полей и иконки.
