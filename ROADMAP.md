# Roadmap

Backlog for **Data Toolkit for Developers**. Restored and triaged from the original `TODO.md`; delivered items are kept rather than deleted so the history stays readable.

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Done

- **Quote-aware delimited parsing** — both code paths used a plain `split()`, so `1,"Smith, John",NYC` became four fields instead of three and shifted every column after it, silently. Now RFC 4180 aware. *(1.1.0)*
- **Valid, unique column identifiers** — duplicate headers produced DDL every engine rejects; `2024 Revenue` produced an identifier that is illegal unquoted; `Total Sales (USD)` produced doubled and trailing underscores. *(1.1.0)*
- **Spark identifier quoting** — Spark was the only dialect emitting bare identifiers, so a reserved word such as `order`, or any name starting with a digit, was a syntax error. Now backtick-quoted like the other three. *(1.1.0)*
- **Full ISO-8601 timestamps** — `2024-03-15T09:30:00.123Z` and `2024-03-15 09:30:00+05:30` were typed as VARCHAR. Fractional seconds and UTC offsets are now recognised. *(1.1.0)*
- **Open in Editor** — generated SQL went to the clipboard only, which is destructive; one unrelated copy and the script is gone. Both the SQL Builder tab and the generate command now offer a new SQL editor tab. *(1.1.0)*
- **Fix SQL generation after data preview** — the preview's "Generate SQL" button behaved as Cancel. `panel.dispose()` fires `onDidDispose` synchronously, so the promise always resolved as cancelled first. *(Fixed in 1.1.0.)*
- **Multi-row inserts** — both the panel and the `generateSQLTable` command emit a single multi-row `INSERT ... VALUES` rather than one statement per row.
- **Make the data preview optional** — the `generateSQLTable` command prompts "Preview data before generating SQL?".
- **Header detection option** — the command prompts whether the first row contains headers, and generates `Column1..N` names when it does not.
- **Dedicated data-import webview** — delivered as the SQL Builder tab: paste tabular data, auto-detect the delimiter, configure dialect and types.

---

## Data engineering gaps

Assessed against a realistic data-engineering workflow, ordered by severity. The
top tier is what a "data toolkit" is judged on: reading real exports without
corrupting them.

### Tier 1 — silently produces wrong data

- ~~Quoted fields break parsing~~ — **done in 1.1.0**, with one limitation left:
  parsing is line-scoped, so a **quoted field containing a newline** still
  breaks. Real exports do contain these. Fixing it means parsing the whole
  document instead of splitting on lines first, in both code paths.
- ~~Duplicate and invalid column identifiers~~ — **done in 1.1.0**.
- **Ragged rows pass silently.** A row with more or fewer fields than the header
  is padded or truncated without comment. It should at least warn, and ideally
  report the offending line numbers.

### Tier 2 — breaks at the scale that motivates using a tool

- **IN clause exceeds engine limits.** Oracle rejects more than 1000 expressions
  (`ORA-01795`); SQL Server degrades badly on very large literal lists. Pasting
  5,000 ids — precisely the case the feature exists for — produces SQL that
  fails. Offer chunking into batches of N (`col IN (...) OR col IN (...)`), or
  emit a `VALUES` CTE or temp table instead.
- **SQL Server caps `INSERT ... VALUES` at 1000 rows.** The table value
  constructor the code uses has a hard limit, so large pastes generate a script
  the engine rejects. Batch into multiple statements.
- **No streaming or chunked processing.** Everything runs in one synchronous
  pass; a very large paste will freeze the panel.

### Tier 3 — real-world data shapes it does not recognise

- **Numbers as spreadsheets export them** — `1,234.56`, `(500)` for accounting
  negatives, `45%`, `$1200`. All become quoted strings, which drags the whole
  column to VARCHAR. Needs to be opt-in: `1,234` is genuinely ambiguous.
- **Non-ISO dates** — `15/03/2024`, `15-Mar-2024`. `DD/MM/YYYY` and `MM/DD/YYYY`
  cannot be told apart from the value alone, so this needs an explicit
  day-first/month-first setting rather than a guess.
- **NULL sentinels.** Only a truly empty field becomes `NULL`; the tokens real
  exports use — `NULL`, `\N` (MySQL), `NA`, `None`, `nan` (pandas) — become
  string literals. Needs a configurable list, plus a way to distinguish empty
  string from NULL.
- **Booleans.** `true`/`false`, `Y`/`N`, `0`/`1` are never inferred as boolean.

### Tier 4 — workflow

- ~~Clipboard-only output~~ — **done in 1.1.0** for SQL. The other commands
  (count values, comma line, compare results) still only reach the clipboard.
- **Modern warehouses missing** — Snowflake, BigQuery, Databricks SQL, Redshift,
  DuckDB. Their type systems differ meaningfully (`INT64`/`NUMERIC` for
  BigQuery, `NUMBER`/`TIMESTAMP_NTZ` for Snowflake), so this is more than an
  alias for an existing dialect.
- **No column profiling.** Null count and percentage, distinct count, min/max,
  length distribution, and inferred type per column — the first thing anyone
  does with an unfamiliar extract. The counting primitives already exist.
- **No idempotent DDL** — `DROP TABLE IF EXISTS`, `CREATE TABLE IF NOT EXISTS`,
  and an optional transaction wrapper.
- **No `UPDATE` or `MERGE` generation** from a two-column id/value list.
- **No primary key or constraint inference** — a column of unique non-null
  values is a candidate key and could be offered as one.

---

## Open

### SQL generation

- **More dialects** — Oracle, SQLite, BigQuery, Snowflake.
- **Schema support** — option to qualify the table with a schema, using each dialect's syntax.
- **Richer type inference** — UUID, JSON, boolean; and a way to manually override an inferred type.
- **Table customisation** — primary keys, indexes, foreign key constraints, table and column comments.
- **Export options** — save generated SQL to a `.sql` file instead of only the clipboard; export in other formats such as JSON; split very large scripts into multiple statements or files.
- **Output formatting** — SQL syntax highlighting in the panel, and a compact vs. expanded formatting choice.

### Data handling

- **Data transformation options** — case conversion (upper / lower / title), whitespace trimming, regex replacement, and date-format conversion applied during a convert.
- **Performance for large inputs** — batch processing so very large selections stay responsive.

### Integrations

- **Database extension integration** — execute the generated SQL directly when a database extension is installed, and preview the execution plan.
- **Template system** — save and reuse conversion configurations, including custom per-dialect templates.

### Codebase

- **Consolidate the duplicated SQL helpers.** The panel's `inferType` / `fmtSqlVal` / `detectSep` are hand-maintained copies of `inferSqlDataType` / `formatSqlValue` / `detectSeparator` in `src/utils/sqlUtils.ts`, because the webview script is a template string and cannot import a module. Options: generate the script from a shared source at build time, or ship a second small esbuild bundle for the webview and load it via a `localResourceRoots` URI. Constraint: keep the bundle small — esbuild output is currently ~78 KB unminified.
- **Reduce the command surface.** The extension contributes 9 commands and a 6-item context submenu. Consider collapsing the rarely used entries into the panel so the palette and right-click menu feel less crowded.

---

## Needs investigation

Two of the original notes have now been checked; two remain open.

### Resolved on inspection

- **"Image is not showing up."** Not reproducible on the current listing. `README.md` uses a repo-relative `<img src="images/icon.png">`, and at package time `vsce` rewrites it to `https://github.com/siddhantvirus/list-to-csv/raw/HEAD/images/icon.png` using the `repository` field, which resolves correctly on the live marketplace page. **Caveat:** this only works while the repository is public — making it private or renaming it would break the marketplace image. If the original report predates the `repository` field being added, that explains it.

- **"I was earlier able to create csv with separate columns. That seems to have gone."** Multi-column output still works. `parseListItems` (`src/extension.ts:578`) splits each line on `/\s{2,}|\t/`, and `generateCSV` pads rows to the widest one. Verified:

  | Input style | Columns produced |
  |---|---|
  | Tab-separated | 3 |
  | Two or more spaces | 3 |
  | **Single space** | **1** |
  | Bullet prefix + tab | 2 |

  The likely source of the complaint is the last case: **single-space-separated values are not split**, because a lone space is ambiguous with spaces inside a value. Worth deciding whether to offer an explicit "split on single space" option rather than changing the default.

### Still open

- **"I want the functionality of converting to single line reserved only for ..."** — the original note is truncated mid-sentence and the intent is unrecoverable. Currently both `convert` (multi-line CSV rows) and `convertToCommaLine` (single joined line) exist as separate commands. Needs a decision on whether the single-line conversion should be restricted to a particular context.

- **"Last Used Setting is now removed."** — ambiguous. `list-to-csv.lastUsedConfigurations` ("Repeat Last Conversion") is still registered and functional, storing per-type configs in `globalState`. Unclear whether this note recorded an intentional removal, a bug, or a plan. Needs confirmation before acting.
