# Changelog

All notable changes to **Data Toolkit for Developers** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.0.0] — 2026-06-14

Full rewrite and rebrand from "List to CSV" to **Data Toolkit for Developers**.

### Added
- **Count & Dedupe tab** — paste a list to count value frequencies (GROUP BY style) or remove duplicates, with copy-to-clipboard output
- **Compare Columns tab** — set operations across two lists: Only in A, In Both, Only in B (Venn diagram logic)
- **SQL Builder tab** — paste tabular data and generate `CREATE TABLE` + `INSERT` scripts for Spark SQL, MS SQL Server, MySQL, and PostgreSQL; auto-detects delimiters and infers data types (INTEGER, DECIMAL, DATE, TIMESTAMP, VARCHAR)
- **Excel Formulas tab** — 20 formula templates across 5 categories (Lookup, Aggregation, Text, Date & Time, Logic & Filter) with live preview as you fill in parameters
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
