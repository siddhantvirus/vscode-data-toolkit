# Data Toolkit — Developer Guide

## Project Structure

```
list-to-csv/
├── src/
│   ├── extension.ts                  # Entry point: registers all commands
│   ├── listToCSVWebviewProvider.ts   # Singleton webview panel (5-tab UI)
│   └── utils/
│       └── sqlUtils.ts               # SQL helpers used by generateSQLTable command
├── images/
│   ├── icon.svg                      # Source icon (edit this, then regenerate PNGs)
│   ├── icon.png                      # 128×128 — used as marketplace icon
│   └── icon-256.png                  # 256×256 — higher-res copy
├── scripts/
│   └── generate-icons.js             # Converts icon.svg → icon.png + icon-256.png (uses sharp)
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

This overwrites `images/icon.png` (128×128) and `images/icon-256.png` (256×256) using the `sharp` package.

## Architecture Notes

### Webview

`ListToCSVWebviewProvider` is a singleton — one panel is reused across commands. The `show()` method creates or reveals the panel. `sendMessage(message)` posts a message into the webview JS context.

The webview HTML, CSS, and JavaScript are all inlined as a TypeScript template literal inside `getWebviewContent()`. Backticks inside the webview JS must be escaped as `\``.

### Command ↔ Webview Communication

- **Extension → Webview**: `panel.webview.postMessage(message)` — webview listens via `window.addEventListener('message', ...)`.
- **Webview → Extension**: `vscode.postMessage(message)` — extension listens via `panel.webview.onDidReceiveMessage(...)`.

### tsconfig

`"lib": ["ES2022", "dom"]` — the `dom` lib is required for `setTimeout` and `console` to resolve in the extension host context.

## Packaging & Publishing

```bash
# Install vsce if not already installed
npm install -g @vscode/vsce

# Package as .vsix
vsce package

# Publish to marketplace (requires PAT configured)
vsce publish
```

The `vscode:prepublish` script runs `npm run package` (production build) automatically before packaging.

## Adding a New Tab

1. Add the tab button and panel HTML inside `getWebviewContent()` in `listToCSVWebviewProvider.ts`.
2. Wire up the tab switch logic in the inline JS (`switchTab` function).
3. If the tab needs to be openable from an editor command, register the command in `extension.ts`, call `listToCSVWebviewProvider.show()`, then `sendMessage({ command: 'switchToTab', tab: 'your-tab-id' })`.

## Key Files

| File | Responsibility |
|---|---|
| `src/extension.ts` | Command registration, editor-selection operations, webview lifecycle |
| `src/listToCSVWebviewProvider.ts` | All UI: HTML/CSS/JS for the 5-tab panel |
| `src/utils/sqlUtils.ts` | `generateSQLTable` command logic (separate from webview SQL Builder) |
