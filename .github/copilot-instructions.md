# Data Toolkit for Developers — VS Code Extension

A VS Code extension for data engineers: convert lists to CSV and SQL `IN` clauses, generate `CREATE TABLE` + `INSERT` scripts, count and deduplicate values, compare two columns, and build Excel formulas.

## Project context

- `src/extension.ts` — command registrations and editor-facing conversions
- `src/listToCSVWebviewProvider.ts` — the Data Toolkit panel (markup, styles, and browser script in a template string)
- `src/utils/sqlUtils.ts` — SQL type inference, value formatting, separator detection
- `src/utils/htmlUtils.ts` — HTML escaping and CSP nonce helpers

## Conventions

- Escape every value that reaches a webview; selected editor text is untrusted input.
- Webviews run under a Content-Security-Policy with a script nonce, so inline `onclick` attributes do not work — use a `data-action` and the `ACTIONS` dispatch table.
- The panel's SQL helpers mirror those in `sqlUtils.ts`; change both together.
- Only plain decimal numbers are emitted as unquoted SQL literals, so zero-padded identifiers keep their padding.

Keep VS Code extension API best practices and bundle size in mind — the extension ships with no runtime dependencies.
