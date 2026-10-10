# Data Toolkit for Developers

<img src="images/icon.png" alt="Data Toolkit Icon" width="128">

[![Marketplace version](https://img.shields.io/visual-studio-marketplace/v/sid-dev.list-to-csv?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=sid-dev.list-to-csv)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/sid-dev.list-to-csv)](https://marketplace.visualstudio.com/items?itemName=sid-dev.list-to-csv)
[![Rating](https://img.shields.io/visual-studio-marketplace/stars/sid-dev.list-to-csv)](https://marketplace.visualstudio.com/items?itemName=sid-dev.list-to-csv&ssr=false#review-details)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A VS Code extension built for data engineers. Convert lists, build SQL scripts, compare columns, count values, deduplicate data, and assemble Excel formulas — all without leaving your editor.

---

## Features at a Glance

| Feature | How to access |
|---|---|
| Convert list to CSV / SQL IN clause | Right-click selection → Data Toolkit |
| Unwrap an IN clause, extract a column, transpose, chunk long IN lists | Right-click selection → Data Toolkit → Transform Selection… |
| JSON ↔ CSV/TSV, table → Markdown, extract a JSON field | Right-click selection → Data Toolkit → Transform Selection… |
| Count value occurrences (GROUP BY) | Right-click selection → Data Toolkit |
| Remove duplicate lines | Right-click selection → Data Toolkit |
| Compare two columns (set operations) | Right-click selection → Data Toolkit |
| Diff two tables by key (added / removed / changed) | Webview → Compare tab → Rows |
| Generate SQL CREATE TABLE + INSERTs | Webview → SQL Builder tab |
| Build Excel formulas with live preview | Webview → Excel Formulas tab |

---

## Context Menu (Right-Click) Commands

Select one or more lines in any editor, right-click, and choose **Data Toolkit** from the context menu.

### Transform Selection…
One entry that opens a searchable list of transforms and applies the one you pick to the selection, in place. Type to filter; **Ctrl+Z** undoes it.

| Transform | Example |
|---|---|
| **Unwrap IN (...) into a list** | `WHERE id IN ('O''Brien','Alice')` → `O'Brien` / `Alice`. Undoes quoting, accepts a whole predicate, and handles `N'...'` values. The exact reverse of building an IN clause. |
| **Extract a column** | Pick a column of pasted tabular data by its header; get just that column, one value per line — ready to turn into an IN list. |
| **Transpose rows and columns** | Rows become columns. Short rows are padded, so no value is lost. |
| **Split a delimited row into lines** | `a,"b,c",d` → `a` / `b,c` / `d`. Quote-aware. |
| **Build a chunked IN clause** | For lists longer than Oracle's 1000-item limit: one value per line in, `(id IN (...) OR id IN (...))` out. Chunk size is configurable, and values are left unquoted only when every one is a plain number. |
| **Convert to CSV or TSV** | JSON, NDJSON or a Markdown table in; CSV or TSV out. Nested objects become dotted columns (`address.city`); arrays stay as JSON in one cell. |
| **Convert a table to JSON** | Header row becomes the keys. JSON array or NDJSON, with numbers, `true`/`false` and empty values typed — or everything kept as text. `007` stays a string. |
| **Convert to a Markdown table** | Tabular data or JSON in; an aligned Markdown table out, ready for a pull request or issue. |
| **Extract a JSON field into a list** | `$.data[*].id` → one id per line. A plain `id` works too: a name applied to an array applies to every element. |

New transforms are added to this list rather than as separate commands, so the palette and menu stay short.

**JSON input** is accepted wherever tabular data is — these transforms, Generate SQL Table, the SQL Builder, and Compare → Rows. A JSON array, a single object, NDJSON (one record per line), or an API response shaped `{"data": [...]}` all work. Long numeric ids are kept exactly; ordinary JSON parsing would round `1234567890123456789` to `1234567890123456800`. Markdown tables are accepted the same way.

### Convert to CSV Format
Converts a multi-line selection into a properly formatted CSV row. Strips bullet points, numbers, and other list prefixes. Respects the delimiter setting.

### Convert to Comma Separated Line
Converts a list into a single comma-separated line. Optionally wraps each value in single quotes — ready to paste into a SQL `IN (...)` clause.

### Generate SQL Table from Selection
Select tabular data (tab- or comma-separated, with a header row) and generate a complete `CREATE TABLE` + `INSERT` script for the target SQL dialect.

If any row has more or fewer fields than the header, you are warned before anything is generated and can stop. Extra fields on a long row would otherwise be dropped — usually because a value contains the delimiter without being quoted.

### Count Value Occurrences (GROUP BY)
Select a list of values and get a `value,count` CSV copied to your clipboard — sorted by frequency descending. Equivalent to `SELECT value, COUNT(*) GROUP BY value ORDER BY 2 DESC`.

### Remove Duplicate Lines
Deduplicates the selected lines in-place, preserving the order of first occurrence.

### Compare Two Columns
Opens the Data Toolkit panel on the Compare tab with Column A pre-filled from the current selection. Paste Column B to run set operations.

---

## Data Toolkit Panel (Webview)

Open via the Command Palette (`Ctrl+Shift+P` → **Data Toolkit: Open Toolkit**) or the right-click menu.

### Tab 1 — List → Line

Paste a list into the input area and convert it with options:

- **Separator**: any character (default `,`)
- **Enclosure**: none, single quotes, or double quotes
- **Wrap as SQL IN ( )**: wraps the result in an `IN (...)` clause
- **Remove duplicates** before converting

Quote characters inside a value are doubled, so `O'Brien` becomes `'O''Brien'` and the clause stays valid. Use **Preview** to see the result, or **Convert & Copy** to copy it to your clipboard.

### Tab 2 — Count & Dedupe

Paste a list to:

- **Count values** — get a `value,count` list (CSV or TSV), sorted by frequency descending
- **Remove duplicates** — see the deduplicated list

Both honour the **Case-sensitive** and **Trim whitespace** options, and the result has a copy-to-clipboard button.

### Tab 3 — Compare Columns

Paste two lists (one per column) and choose a set operation:

| Operation | Description |
|---|---|
| Only in A | Values present in Column A but not Column B |
| In Both | Values present in both columns (intersection) |
| Only in B | Values present in Column B but not Column A |

All three result sets are shown side by side with counts, and each has its own copy button. **Case-sensitive** and **Trim whitespace** options control how values are matched.

**Rows (tabular) mode** compares two tables instead of two lists. Paste tabular data with a header row, a Markdown table, or JSON into each side — the two sides need not be the same format, so a JSON export can be checked against a CSV; rows are matched on a key column (auto-selected, overridable) and classified as added, removed, changed or unchanged, with the differing fields highlighted inline as `before → after`.

| | Meaning |
|---|---|
| `+` | Row only in B |
| `−` | Row only in A |
| `~` | Same key, at least one field differs |
| `=` | Identical — hidden unless **Show unchanged rows** is ticked |

Columns are matched by header name, so reordering them is not treated as a change. Duplicate keys and columns present on only one side are reported as warnings rather than silently affecting the result.

### Tab 4 — SQL Builder

Paste tabular data (auto-detects tab, comma, pipe, or space-aligned columns), a Markdown table, or JSON, and configure:

- **Table name**
- **SQL dialect**: Spark SQL, MS SQL Server, MySQL, PostgreSQL
- **Infer data types**: automatically detects INTEGER, DECIMAL, DATE, TIMESTAMP, VARCHAR
- **Size VARCHAR to sample**: off by default (`VARCHAR(255)`); enable for widths derived from the pasted data

Generates a `CREATE TABLE` statement and `INSERT` rows. Copy the script to your clipboard, or **Open in Editor** to send it to a new SQL tab.

Input is parsed with RFC 4180 quoting, so a field like `"Smith, John"` stays one column. Column names are made into valid, unique SQL identifiers — duplicates are suffixed and names starting with a digit are prefixed. Identifiers are quoted only when they need it, so `my_table` stays bare while a reserved word such as `order` is quoted; tick **Always quote identifiers** to quote everything.

**Example input:**
```
id	name	hire_date	salary
1	Alice	2022-03-15	75000
2	Bob	2021-07-01	82000
```

**Example output (PostgreSQL):**
```sql
CREATE TABLE "employees" (
    "id" INTEGER,
    "name" VARCHAR(255),
    "hire_date" DATE,
    "salary" INTEGER
);

INSERT INTO "employees" ("id", "name", "hire_date", "salary") VALUES
    (1, 'Alice', '2022-03-15', 75000),
    (2, 'Bob', '2021-07-01', 82000);
```

With **Size VARCHAR to sample** enabled, `"name"` becomes `VARCHAR(10)` instead.

Values that only *look* numeric are kept as text, so zero-padded identifiers like `007` survive the round trip instead of being written as `7`.

Rows with a different number of fields from the first row are flagged above the output, with their row numbers, rather than being padded or truncated silently.

### Tab 5 — Excel Formulas

Select a formula category, choose a formula, fill in the parameters, and copy the result. A live preview updates as you type.

**Available formulas by category:**

| Category | Formulas |
|---|---|
| Lookup | VLOOKUP, XLOOKUP, INDEX / MATCH |
| Aggregation | SUMIF, SUMIFS, COUNTIF, COUNTIFS, AVERAGEIF |
| Text | TEXTJOIN, CONCAT, LEFT, MID, TEXT, SUBSTITUTE |
| Date & Time | DATEDIF, EOMONTH, NETWORKDAYS, YEAR / MONTH / DAY |
| Logic & Filter | IFERROR, IFS, UNIQUE, FILTER, SORT |

---

## Settings

These settings apply to the **Convert to CSV Format** command. The panel has its own per-tab options.

| Setting | Default | Description |
|---|---|---|
| `list-to-csv.delimiter` | `,` | Field separator for CSV output |
| `list-to-csv.includeHeaders` | `true` | Add a generated `Column 1, Column 2, ...` header row |
| `list-to-csv.quoteAllFields` | `false` | Quote every field, not only those that need it |
| `list-to-csv.escapeCharacter` | `"` | Quote character used around fields |
| `list-to-csv.varcharSizing` | `fixed` | `fixed` for `VARCHAR(255)`, or `fromSample` to size columns to the widest sampled value (applies to SQL generation) |
| `list-to-csv.quoteIdentifiers` | `auto` | `auto` quotes only names that need it; `always` quotes every table and column name (applies to SQL generation) |

Open settings via `Ctrl+Shift+P` → **Data Toolkit: Open Extension Settings**.

---

## Commands Reference

| Command | ID | Description |
|---|---|---|
| Open Toolkit | `list-to-csv.openWebview` | Open the Data Toolkit panel |
| Transform Selection… | `list-to-csv.transform` | Pick a transform to apply to the selection in place |
| Convert to CSV | `list-to-csv.convert` | Convert selection to CSV rows |
| Comma Separated Line | `list-to-csv.convertToCommaLine` | Convert selection to a single line |
| Generate SQL Table | `list-to-csv.generateSQLTable` | Generate CREATE TABLE + INSERTs |
| Count Values | `list-to-csv.countValues` | Count occurrences, copy value,count CSV |
| Remove Duplicates | `list-to-csv.removeDuplicates` | Deduplicate selection in-place |
| Compare Columns | `list-to-csv.compareColumns` | Open Compare tab with Column A pre-filled |
| Repeat Last Conversion | `list-to-csv.lastUsedConfigurations` | Rerun the most recent conversion |
| Open Settings | `list-to-csv.openSettings` | Jump to extension settings |

---

## Requirements

No external dependencies. Works out of the box with VS Code 1.101.0 and later.

Everything runs locally — the extension makes no network requests and collects no telemetry.

---

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for build and development instructions, and [open an issue](https://github.com/siddhantvirus/vscode-data-toolkit/issues) for anything that looks wrong.

---

## License

[MIT](LICENSE)
