# Contributing

Thanks for taking the time to contribute. Bug reports, feature ideas, and pull requests are all welcome.

## Getting started

```bash
npm install
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded. Reload that window after each rebuild to pick up changes.

## Scripts

| Script | What it does |
|---|---|
| `npm run compile` | Type-check, lint, and bundle to `dist/` |
| `npm run watch` | Rebuild continuously while developing |
| `npm run package` | Production build (minified) — runs before publishing |
| `npm run check-types` | TypeScript type checking only |
| `npm run lint` | ESLint |
| `npm test` | Compile and run the test suite |

## Project layout

- `src/extension.ts` — command registrations and the editor-facing conversions
- `src/listToCSVWebviewProvider.ts` — the Data Toolkit panel (HTML, CSS, and browser script)
- `src/utils/sqlUtils.ts` — SQL type inference, value formatting, separator detection
- `src/utils/htmlUtils.ts` — HTML escaping and CSP nonce helpers
- `esbuild.js` — bundling configuration

TypeScript is used for type checking only (`tsc --noEmit`); esbuild produces the actual bundle at `dist/extension.js`.

[docs/DEVELOPING.md](docs/DEVELOPING.md) covers the architecture in depth: the webview messaging contract, icon regeneration, packaging, and how to add a tab.

## Working on the webview

The panel's markup and script live in a template string in `listToCSVWebviewProvider.ts`. Three rules matter there:

1. **Never interpolate user data into HTML unescaped.** Selected editor text reaches the webview, so route every value through `escHtml` (in the webview) or `escapeHtml` (in extension code).
2. **No inline event handlers.** The webview runs under a Content-Security-Policy with a script nonce, which blocks `onclick="..."` attributes. Give the element a `data-action` and register the handler in the `ACTIONS` table instead.
3. **Escape backticks as `` \` ``.** The whole document is a template literal, so an unescaped backtick terminates it silently.

The panel's `inferType` / `fmtSqlVal` / `detectSep` are hand-maintained copies of the equivalents in `sqlUtils.ts` — change both together. Removing that duplication is tracked in [ROADMAP.md](ROADMAP.md).

## Testing

```bash
npm test
```

The suite covers the pure utilities (type inference, value formatting, separator detection, HTML escaping) plus a command-registration smoke test.

> **Note:** `@vscode/test-cli` cannot launch from a path containing spaces — it truncates the path at the first space. If `npm test` fails with `Cannot find module`, clone into a path without spaces.

## Pull requests

- Keep `npm run compile` clean (types and lint both pass).
- Add or update tests when changing utility behaviour.
- Add a `CHANGELOG.md` entry under an "Unreleased" heading.

## Releasing

Publishing is gated. The `Publish` workflow is manual-dispatch only and runs against the protected `release` environment, so it pauses for maintainer approval before the marketplace token is available. `VSCE_PAT` is an environment secret, not a repository secret, and pull requests from forks never receive it.

### Version numbering

The Marketplace rejects semver pre-release suffixes — `1.2.0-beta.1` is not a valid extension version. Versions must be plain `major.minor.patch` integers, so the channel is encoded in the **minor number** instead:

| Channel | Minor | Examples |
|---|---|---|
| Stable | even | `1.2.0`, `1.4.0`, `1.6.0` |
| Pre-release | odd | `1.3.0`, `1.3.1`, `1.3.2` |

Users who opt into pre-releases get the odd versions; everyone else stays on the newest even one. Versions must always increase, and a version can never be reused — publishing to the wrong channel burns that number permanently. The **Check version matches channel** step enforces the parity before anything reaches the Marketplace.

> `1.1.0` predates this convention and shipped to stable on an odd minor. The next stable release is `1.2.0`.

### Releasing

1. Merge work to `main` — CI must be green.
2. **Pre-release:** set `version` to the next odd-minor patch (`1.3.0`, then `1.3.1`, …), merge, then run **Publish** with channel `pre-release`. Repeat as often as useful.
3. **Stable:** when the pre-release line is proven, bump to the next even minor (`1.4.0`), move the `CHANGELOG.md` `[Unreleased]` section under it, and merge.
4. Tag the merge commit: `git tag -a v1.4.0 origin/main -m "..." && git push origin v1.4.0`. Tags are markers only and do not trigger publishing.
5. Run **Publish** with channel `stable` and approve the deployment when prompted.

Run it once with **dry_run** checked to exercise the build and download the packaged `.vsix` artifact without publishing.

`VSCE_PAT` is seeded with a placeholder so the environment could be configured before the token existed. Until it is replaced with a real Azure DevOps PAT, a non-dry-run will stop at the "Verify marketplace token is real" step with an explicit message. Replace it in **Settings → Environments → release → Secrets** — never commit a token or paste one into an issue or PR.

The local fallback is documented in [docs/DEVELOPING.md](docs/DEVELOPING.md#packaging--publishing).

## Roadmap

Open items and known issues live in [ROADMAP.md](ROADMAP.md).
