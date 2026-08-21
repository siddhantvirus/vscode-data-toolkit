# Changelog

All notable changes to **Data Toolkit for Developers** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.1.1] — 2026-08-18

Pre-release.

### Fixed

- **Form controls clipped their text.** The dialect dropdown and the text inputs took their font from `--vscode-editor-font-size` inside a fixed 28px box, which — with `box-sizing: border-box` — left only 14px of content height. The editor font defaults to 14px and is commonly set higher, so the text did not fit. Configuration controls now use the UI font and a `min-height`, making them independent of the editor font setting. Textareas keep the monospace editor font, since aligning pasted columns is their purpose.

---

## [1.1.0] — 2026-08-18

Pre-release — the first release on the pre-release channel under the
even/odd minor convention. See `CONTRIBUTING.md` for the numbering scheme.

### Fixed

- **Quoted fields were split apart.** Both code paths used a plain `split()` on the delimiter, so `1,"Smith, John",NYC` parsed as four fields instead of three and shifted every column after it — with no error. Parsing is now RFC 4180 aware. *(A quoted field containing a newline is still unsupported; see `ROADMAP.md`.)*
- **Duplicate column names produced invalid DDL.** Two columns named `Region` emitted `CREATE TABLE t ("Region" ..., "Region" ...)`, which every engine rejects. Names are now made unique (`Region`, `Region_2`)
- **Identifiers could be illegal.** `2024 Revenue` became `2024_Revenue`, which is invalid unquoted in every dialect, and `Total Sales (USD)` became `Total_Sales__USD_` with doubled and trailing underscores. Names starting with a digit are now prefixed, and underscore runs collapsed
- **Spark SQL emitted bare identifiers**, so a reserved word such as `order` — or any column starting with a digit — was a syntax error. Spark identifiers are now backtick-quoted like the other three dialects
- **Full ISO-8601 timestamps were typed as VARCHAR.** `2024-03-15T09:30:00.123Z` and `2024-03-15 09:30:00+05:30` are now recognised as timestamps; fractional seconds and UTC offsets are both handled
- **Generating SQL after the data preview did nothing.** `panel.dispose()` fires `onDidDispose` synchronously, so the preview always resolved as "cancelled" before the "Generate SQL" result could be returned — the button behaved exactly like Cancel
- **Escaped HTML in the data preview.** Selected text was interpolated straight into the preview webview, so content such as `<img src=x onerror=...>` executed as script. All headers, cells, and the table name are now escaped, and both webviews declare a Content-Security-Policy with a script nonce
- **`IN (...)` clauses broke on values containing quotes.** `O'Brien` produced `'O'Brien'`; quote characters inside a value are now doubled, in both the command and the panel
- **A custom quote character could break or corrupt CSV output.** The `escapeCharacter` setting was interpolated into a `RegExp` unescaped, so `(` threw a `SyntaxError` and `|` matched every position. The pattern is now escaped and an empty setting falls back to `"`
- **Space-aligned data was split on every single space**, turning each word into its own column. Runs of two or more spaces are now used as the separator
- **Zero-padded values lost their padding.** `Number()` accepted `00123`, `0x1F`, `1e5`, and `Infinity` as numeric, so zero-padded ids and zip codes were written unquoted and silently renumbered. Only plain decimal integers and decimals are emitted as numeric literals now
- **`CREATE TABLE` was only terminated for PostgreSQL.** Spark SQL, MySQL, and MS SQL Server emitted no trailing semicolon — notably `USING DELTA` with nothing after it — so the script failed when run as more than one statement. Every dialect now terminates both `CREATE TABLE` and `INSERT`, and the semicolon sits on the last line rather than on one of its own
- **A width was computed for `VARCHAR` columns but never used**, and a loop that exited early could leave it short. Both are fixed, and the width is now controllable — see `list-to-csv.varcharSizing` below
- **Messages to the panel could be dropped.** Prefilling the input and switching to the Compare tab relied on a 300 ms timer; the panel now reports when it is ready and queued messages are replayed
- **Reopening the panel overwrote the Convert tab.** Text already typed there is no longer replaced by the current selection
- Values pasted from Windows files kept a trailing carriage return inside the quotes; all inputs now split on CRLF as well as LF
- **Local tooling state was being packaged into the VSIX.** `.claude/settings.local.json` was included in the published extension, exposing absolute paths from the maintainer's machine; `.claude/**` is now excluded

### Added
- **Remove duplicates** option on the Convert tab, which the README already documented
- **Open in Editor** — generated SQL can now be opened in a new SQL editor tab instead of only the clipboard, from both the SQL Builder tab and the generate command
- `list-to-csv.varcharSizing` setting and a matching **Size VARCHAR to sample** checkbox on the SQL Builder tab. Defaults to a fixed `VARCHAR(255)`, since a pasted sample is usually a subset of the real data and a width derived from it can truncate later rows; opt in for tighter schemas
- Unit tests covering type inference, SQL value formatting, separator detection, and HTML escaping
- `CONTRIBUTING.md` with build, layout, and webview guidance
- `docs/DEVELOPING.md` — architecture, webview messaging contract, icon regeneration, packaging, and how to add a tab
- `ROADMAP.md` — triaged backlog and known issues
- GitHub Actions CI running type-check, lint, build, and tests, plus a manual-dispatch publish workflow gated behind a protected environment

### Changed
- Settings descriptions now state that they apply to the "Convert to CSV Format" command
- Settings category renamed from "List to CSV" to "Data Toolkit for Developers"
- `package.json` declares `license`, `bugs`, and `homepage`
- Dropped `"dom"` from the `tsconfig.json` `lib` array — the `setTimeout` and `console` call sites that needed it are gone, and omitting it keeps browser-only APIs from type-checking in extension-host code

### Removed
- Compiled `.js`/`.js.map` output and a `.ts.bak` file that were committed under `src/`
- `TODO.md`, `INSTRUCTIONS.md`, and `vsc-extension-quickstart.md` (internal notes and scaffolding; the build steps and roadmap moved to `CONTRIBUTING.md`)
- Generated-template `console.log` on activation

---

## [1.0.0] — 2026-06-14

Full rewrite and rebrand from "List to CSV" to **Data Toolkit for Developers**.

### Added
- **Count & Dedupe tab** — paste a list to count value frequencies (GROUP BY style) or remove duplicates, with copy-to-clipboard output
- **Compare Columns tab** — set operations across two lists: Only in A, In Both, Only in B (Venn diagram logic)
- **SQL Builder tab** — paste tabular data and generate `CREATE TABLE` + `INSERT` scripts for Spark SQL, MS SQL Server, MySQL, and PostgreSQL; auto-detects delimiters and infers data types (INTEGER, DECIMAL, DATE, TIMESTAMP, VARCHAR)
- **Excel Formulas tab** — 23 formula templates across 5 categories (Lookup, Aggregation, Text, Date & Time, Logic & Filter) with live preview as you fill in parameters
- Right-click command: **Count Value Occurrences (GROUP BY)** — copies `value,count` CSV to clipboard from the current selection
- Right-click command: **Remove Duplicate Lines** — deduplicates the selection in-place, preserving first-occurrence order
- Right-click command: **Compare Two Columns** — opens the Compare tab with Column A pre-filled from the current selection
- Webview panel retains state when hidden (`retainContextWhenHidden`)
- `sendMessage` API on `ListToCSVWebviewProvider` for extension-to-webview communication

### Changed
- Extension display name: "List to CSV" → "Data Toolkit for Developers"
- Panel title: "List to CSV" → "Data Toolkit"
- All command titles prefixed with "Data Toolkit:" for consistency
- Context menu submenu label: "List to CSV Options" → "Data Toolkit"
- Icon redesigned: data table grid with SQL, f(x), and compare badges replacing the original list-and-arrow design
- Keywords updated to include data engineering terms

### Removed
- `ensureSampleHtmlExists()` — had a hardcoded development path; Sample.HTML is no longer used
- `generateSqlTableScript()` — internal helper that was never called externally
- Smiley face from the extension icon

### Fixed
- Added `"dom"` to `tsconfig.json` lib array to resolve pre-existing `console` and `setTimeout` type errors

---

## [0.0.1] — Initial release

- Convert bullet, numbered, and plain-text lists to CSV rows
- Convert list to comma-separated single line (with SQL IN clause option)
- Configurable delimiter, quote style, and header row settings
- Interactive WebView for conversion options
- Command Palette integration
