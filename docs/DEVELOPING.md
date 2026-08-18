# Data Toolkit — Developer Guide

Deep-dive reference for working on the extension. For contribution process and scripts, see [CONTRIBUTING.md](../CONTRIBUTING.md); for the backlog, see [ROADMAP.md](../ROADMAP.md).

## Project Structure

```
list-to-csv/
├── src/
│   ├── extension.ts                  # Entry point: registers all commands
│   ├── listToCSVWebviewProvider.ts   # Singleton webview panel (5-tab UI)
│   └── utils/
│       ├── sqlUtils.ts               # Delimited parsing, identifiers, type inference, value formatting
│       ├── htmlUtils.ts              # HTML escaping, CSP nonce, RegExp escaping
│       └── editorUtils.ts            # Open generated SQL in a new editor tab
├── docs/
│   └── DEVELOPING.md                 # This file
├── images/
│   ├── icon.svg                      # Source icon (edit this, then regenerate PNGs)
│   ├── icon.png                      # 128×128 — used as marketplace icon
│   └── icon-256.png                  # 256×256 — higher-res copy
├── scripts/
│   ├── generate-icons.js             # Converts icon.svg → icon.png + icon-256.png (uses sharp)
│   └── inspect-vsix.js               # Builds a VSIX and lists its contents
├── package.json
├── tsconfig.json
└── esbuild.js                        # Bundles dist/extension.js for the packaged extension
```

## Running in Development

1. Press `F5` to launch the **Extension Development Host** — a second VS Code window with the extension loaded.
2. In that window, right-click any selected text to see the **Data Toolkit** context menu.
3. Open the Command Palette (`Ctrl+Shift+P`) and search **Data Toolkit** to see all registered commands.

Set breakpoints in `src/extension.ts` or `src/listToCSVWebviewProvider.ts`; they will be hit when the corresponding commands run.

## Build

```bash
npm run compile       # type-check + lint + bundle (development)
npm run package       # type-check + lint + bundle (production, minified)
npm run check-types   # tsc --noEmit only
npm run lint          # eslint src
```

The compiled output goes to `dist/extension.js` (via esbuild). The `out/` directory is used only by the test runner (`compile-tests`).

## Regenerating Icons

After editing `images/icon.svg`:

```bash
node scripts/generate-icons.js
```

This overwrites `images/icon.png` (128×128) and `images/icon-256.png` (256×256) using the `sharp` package, which is a devDependency.

## Inspecting the Package

```bash
npm run inspect-vsix
```

Builds the extension, packages a `.vsix`, and lists its contents so you can confirm what ships.

> **Windows note:** this script shells out to `unzip`, which stock Windows does not provide. Run it from Git Bash, or unzip the `.vsix` manually — it is an ordinary ZIP archive.

## Architecture Notes

### Webview

`ListToCSVWebviewProvider` is a singleton — one panel is reused across commands. `show(options)` creates or reveals the panel; pass `{ prefillInput: false }` when targeting a tab other than Convert. `sendMessage(message)` posts a message into the webview JS context.

The webview HTML, CSS, and JavaScript are all inlined as a TypeScript template literal inside `_getWebviewContent()`.

**Backticks inside the webview JS must be escaped as `` \` ``** — the whole document lives in a template literal, so an unescaped backtick silently terminates it. See `quoteId()`, which emits MySQL identifier quotes.

For the same reason, regex literals and `${...}` sequences inside the webview script need escaping (`\\s`, `\\n`, `\\r`) so they survive into the emitted string rather than being interpreted by TypeScript.

### Security constraints

Both webviews declare a Content-Security-Policy with a per-render script nonce. Two consequences:

1. **No inline event handlers.** `onclick="..."`, `oninput="..."`, and `onchange="..."` attributes are blocked. Give the element a `data-action` (plus optional `data-arg`) and register the function in the `ACTIONS` table; a delegated listener dispatches it, which also covers markup rendered later such as the formula builder. Assigning `element.onclick = fn` from JavaScript is fine — only inline *attributes* are blocked.
2. **Never interpolate user data into HTML unescaped.** Selected editor text reaches both webviews. Route every value through `escHtml` (inside the webview script) or `escapeHtml` from `src/utils/htmlUtils.ts` (in extension code).

### Command ↔ Webview Communication

- **Extension → Webview**: `panel.webview.postMessage(message)` — the webview listens via `window.addEventListener('message', ...)`.
- **Webview → Extension**: `vscode.postMessage(message)` — the extension listens via `panel.webview.onDidReceiveMessage(...)`.

The webview posts `{ command: 'ready' }` once its script has run. Messages sent before that are queued by the provider and replayed on receipt, so prefilling input or switching tabs cannot lose a race against webview load.

### Duplicated SQL logic

The webview script is a string and cannot import a module, so these pairs are hand-maintained copies — **change both together**:

| Webview | `src/utils/sqlUtils.ts` |
|---|---|
| `inferType` | `inferSqlDataType` |
| `fmtSqlVal` | `formatSqlValue` |
| `detectSep` | `detectSeparator` |
| `parseDelimitedLine` | `parseDelimitedLine` |
| `sanitizeColumnNames` | `sanitizeColumnNames` |
| `isPlainNumber` | `isPlainNumber` |

Consolidating them is tracked in [ROADMAP.md](../ROADMAP.md).

### Parsing rules

`parseDelimitedLine` implements RFC 4180 quoting for single-character delimiters — a field like `"Smith, John"` stays one column, and `""` inside a quoted field is an escaped quote. Space-aligned columns use a RegExp separator, which has no quoting convention, so those fall back to a plain split.

It is **line-scoped**: a quoted field containing a newline is not supported, because both pipelines split on lines before parsing fields. Fixing that means parsing the whole document first.

`sanitizeColumnNames` guarantees identifiers that every dialect accepts: punctuation collapsed to single underscores, leading digits prefixed with `col_`, blanks named positionally, and duplicates suffixed case-insensitively.

### tsconfig

`rootDir` is `src` and `outDir` is `out`, but `out/` is only used by the test runner — esbuild produces the shipped bundle independently.

The `lib` array is `["ES2022"]`. A `"dom"` entry was previously required for `setTimeout` and `console` to resolve; both call sites have since been removed, so it is no longer needed. Leaving `dom` out is deliberate — it stops browser-only APIs from type-checking inside extension-host code, where they do not exist.

## Packaging & Publishing

```bash
# Install vsce if not already installed
npm install -g @vscode/vsce

# Package as .vsix (for local install or testing)
vsce package

# Publish to the marketplace (requires a PAT)
vsce publish
```

The `vscode:prepublish` script runs `npm run package` (production build) automatically before packaging.

The extension is published on the **stable** channel as `sid-dev.list-to-csv`. Do not pass `--pre-release` unless you intend to move it to the pre-release channel.

Preferred route is the gated GitHub Actions workflow — see [CONTRIBUTING.md](../CONTRIBUTING.md#releasing).

> **Marketplace images depend on the repo staying public.** `README.md` uses a repo-relative `<img src="images/icon.png">`. At package time `vsce` rewrites that to `https://github.com/siddhantvirus/list-to-csv/raw/HEAD/images/icon.png` using the `repository` field. If the repository is ever made private or renamed, that URL 404s and the marketplace icon breaks.

## Adding a New Tab

1. Add the tab button and panel HTML inside `_getWebviewContent()` in `listToCSVWebviewProvider.ts`.
2. Wire up the tab switch logic — the delegated handler reads `data-tab`, and `switchToTab(name)` activates a tab by name.
3. Register any buttons in the `ACTIONS` table rather than using inline `onclick`.
4. If the tab needs to be openable from an editor command, register the command in `extension.ts`, call `listToCSVWebviewProvider.show({ prefillInput: false })`, then `sendMessage({ command: 'switchToTab', tab: 'your-tab-id' })`.

## Key Files

| File | Responsibility |
|---|---|
| `src/extension.ts` | Command registration, editor-selection operations, webview lifecycle |
| `src/listToCSVWebviewProvider.ts` | All panel UI: HTML/CSS/JS for the 5 tabs |
| `src/utils/sqlUtils.ts` | SQL type inference, value formatting, separator detection |
| `src/utils/htmlUtils.ts` | HTML escaping, CSP nonce generation, RegExp escaping |
