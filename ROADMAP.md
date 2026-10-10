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

## Build order

Sequenced deliberately. Phase 0 exists because the items after it depend on
it: format interop needs correct parsing, and every SQL feature currently has
to be written twice by hand.

| Phase | Goal |
|---|---|
| 0 | Foundations — correct parsing, and stop duplicating logic across the webview |
| 1 | Format interop and reverse conversions |
| 2 | List transforms, reshaping, profiling |
| 3 | SQL depth, SQL productivity, utilities |

### How new transforms are surfaced

New transforms go behind **one** `Data Toolkit: Transform…` quick-pick — a
single palette entry and a single context-menu item — not one command each.
The extension already contributes 9 commands and a 6-item submenu; adding a
command per transform would take it past 40 and make the palette unusable.
A quick-pick costs no new surface per transform and filters by typing.

Three or four of the highest-frequency transforms can be promoted to their own
commands later if they prove worth a keybinding.

---

## Phase 0 — foundations

- ~~Parse quoted fields containing newlines~~ — **done in 1.1.3**.
  `parseDelimitedText` parses the whole document rather than splitting on lines
  first, so quoting is honoured across line breaks in both pipelines.
- ~~Consolidate the duplicated SQL logic~~ — **done in 1.1.6**. The panel script
  moved to `src/webview/main.ts`, built as its own esbuild entry point and
  loaded via `asWebviewUri`, so it imports the same helpers the extension host
  uses. Twelve hand-maintained pairs are gone.

  **Phase 0 is complete; Phase 1 is unblocked.** Remaining follow-up: the panel
  script is checked with `strict: false` (`tsconfig.webview.json`) because it
  was lifted wholesale out of a template literal where it had never been
  type-checked at all. Tightening it is worthwhile but independent of the move.

---

## Phase 1 — format interop and reverse conversions

Format interop is the single largest gap: JSON is the default interchange
format for this audience and is absent entirely.

### Formats

All **done in 1.2.0**. JSON goes through one entry point
(`parseStructuredTable`), so every table-shaped feature accepts it — the SQL
Builder, the generate command, Compare → Rows and the transforms.

- ~~Tabular/CSV → JSON~~ — array of objects, header row as keys, with optional
  type inference that keeps `007` a string.
- ~~JSON → CSV/tabular~~ — union of keys across all objects; nested objects
  flattened to dotted columns, arrays kept as JSON cells.
- ~~NDJSON~~ as both input and output.
- ~~JSON → SQL `INSERT`~~ — by accepting JSON in the existing SQL paths rather
  than a separate command.
- ~~Extract a field by JSON path~~ — `$.items[*].id`, or just `id`.
- ~~Markdown table~~ as output, and as input.

A custom parser is used instead of `JSON.parse`, which rounds integers past
2^53 — an 18-digit id would silently change in the generated SQL.

### Reverse conversions

Every existing conversion is one-directional; these restore symmetry.

All four **done in 1.2.0**, behind the `Transform Selection…` quick-pick:

- ~~Unwrap a SQL `IN (...)` clause~~ — the exact inverse of building one,
  including doubled quotes, whole `WHERE` predicates and `N'...'` values.
- ~~CSV row → lines~~ — quote-aware.
- ~~Transpose~~ — pads short rows, so no value is lost.
- ~~Extract column N~~ — chosen by header from the first row.

---

## Phase 2 — transforms, reshaping, profiling

### List transforms

All behind the `Transform…` quick-pick, operating in place on a selection.

- **Sort** — alphabetical, numeric, natural/version order, reverse.
- **Change case** — upper, lower, Title, snake_case, camelCase, kebab-case.
- **Trim and normalise whitespace** — as a first-class command, not only an
  option on other tools.
- **Add prefix/suffix or wrap each line**.
- **Filter lines by regex** — keep or drop matches.
- **Extract all regex matches**, including capture groups.

### Reshaping and aggregation

- **Pivot / unpivot (wide ↔ long)** — the most-requested reshape for analysts
  and entirely missing.
- **Group by with an aggregate** on a second column — sum, avg, min, max.
  Only `COUNT` exists today.
- **Dedupe by key column**, keeping the first or last row. Distinct from the
  existing whole-line dedupe.
- **Frequency table** with percentage, cumulative percentage and top-N cutoff.

### Profiling

- **Primary-key candidate detection** — which column, or combination, is
  unique across the sample.
- **Cardinality and selectivity** per column — distinct count, and as a ratio.
- **Numeric distribution buckets** as a text histogram.
- **Null-completeness summary** across all columns at once.

---

## Phase 3 — SQL depth, productivity, utilities

### SQL Builder

- **More dialects** — SQLite, Snowflake, BigQuery, Redshift, DuckDB,
  Databricks, Oracle. Type systems differ meaningfully, so each is real work
  rather than an alias.
- **`MERGE`/`UPSERT`**, and **`UPDATE`/`DELETE`** generation.
- ~~Batched inserts~~ — **done in 1.2.0**: 1000 rows per statement by default,
  configurable.
- **Bulk-load commands** — `COPY` for PostgreSQL/Redshift, `COPY INTO` for
  Snowflake/Databricks.
- **Richer type inference** — nullability and UUID. Boolean, `BIGINT` and exact
  `DECIMAL(38,s)` are **done in 1.2.0**.
- **Save to file** — `.sql`, `.csv`, `.json`, complementing Open in Editor.

### SQL productivity

- **Column-list helpers** — turn a list of column names into a `SELECT` list,
  a `GROUP BY` list, or join conditions (`a.col = b.col`).
- ~~`IN (...)` chunking~~ — **done in 1.2.0** as a transform: OR'd batches of a
  configurable size, 1000 by default for Oracle's limit (`ORA-01795`).
- **Query scaffolds** — pivot via `CASE WHEN`, window functions
  (`ROW_NUMBER`/`RANK`/`LAG`/`LEAD`), and a date-spine/calendar table.

### Compare and Count depth

- **Compare more than two columns** — extend the set operations beyond A vs B.
- ~~Row-level comparison~~ — **done in 1.1.4** as a Rows mode on the Compare tab:
  keyed diff with added/removed/changed/unchanged, per-field change highlighting,
  and warnings for duplicate keys and schema drift. Follow-ups: composite keys,
  and emitting `UPDATE` statements for changed rows (Phase 3).
- **Duplicates within a single column** — report which values repeat and how
  often, rather than removing them.

### Utilities

- **Encode/decode** — URL, base64, HTML entities.
- **Hash or redact a column** — md5/sha, for masking PII before sharing a
  sample.
- **Date normalisation to ISO 8601**, handling mixed formats in one column.

---

## Out of scope

Considered and deliberately not planned. Recorded so they are not re-proposed.

- **SQL formatter for arbitrary statements.** Formatting arbitrary SQL across
  seven-plus dialects with no external dependency means writing a SQL parser —
  a project in itself, and a half-correct formatter that mangles someone's
  query is worse than none.
- **Sample/fake data generation.** Overlaps a well-served category of dedicated
  tools, and the name and pattern tables would dominate the bundle, which is
  currently ~84 KB.
- **Standalone SQL string escaping.** Already exists inside `formatSqlValue`
  for generated SQL; as its own command it adds surface for very little.
- **HTML table output** — deferred behind Markdown, which covers PR
  descriptions and issues. Revisit only if asked for.

---

## Data engineering gaps

Assessed against a realistic data-engineering workflow, ordered by severity. The
top tier is what a "data toolkit" is judged on: reading real exports without
corrupting them.

### Tier 1 — silently produces wrong data

- ~~Quoted fields break parsing~~ — **done in 1.1.0**, and the remaining
  line-scoped limitation (a quoted field containing a newline) was closed in
  **1.1.3** by parsing the whole document rather than splitting on lines first.
- ~~Duplicate and invalid column identifiers~~ — **done in 1.1.0**.
- ~~Ragged rows pass silently~~ — **done in 1.2.0**. The generate command warns
  and asks before continuing, naming the rows; the SQL Builder tab shows the
  same warning above its output. Tier 1 is now clear.

### Tier 2 — breaks at the scale that motivates using a tool

- **IN clause exceeds engine limits.** Oracle rejects more than 1000 expressions
  (`ORA-01795`); SQL Server degrades badly on very large literal lists. Pasting
  5,000 ids — precisely the case the feature exists for — produces SQL that
  fails. **Chunking done in 1.2.0** (`col IN (...) OR col IN (...)`); emitting a
  `VALUES` CTE or temp table instead remains open.
- ~~SQL Server caps `INSERT ... VALUES` at 1000 rows~~ — **done in 1.2.0**.
  Inserts are batched, 1000 rows per statement by default.
- ~~Integers past `INT` overflow~~ — **done in 1.2.0**. A 19-digit id was typed
  `INT`; now `BIGINT`, or `DECIMAL(38,0)` beyond that. JSON input keeps such ids
  exact rather than rounding them through `JSON.parse`.
- **No streaming or chunked processing.** Everything runs in one synchronous
  pass; a very large paste will freeze the panel.

### Tier 3 — real-world data shapes it does not recognise

- **Numbers as spreadsheets export them** — `1,234.56`, `(500)` for accounting
  negatives, `45%`, `$1200`. All become quoted strings, which drags the whole
  column to VARCHAR. Needs to be opt-in: `1,234` is genuinely ambiguous.
- **Non-ISO dates** — `15/03/2024`, `15-Mar-2024`. `DD/MM/YYYY` and `MM/DD/YYYY`
  cannot be told apart from the value alone, so this needs an explicit
  day-first/month-first setting rather than a guess.
- ~~NULL sentinels~~ — **done in 1.2.0** as a configurable list, `NULL` and
  `\N` by default. Still open: a way to keep an empty string distinct from NULL.
- ~~Booleans~~ — **done in 1.2.0** for `true`/`false`. `Y`/`N` and `0`/`1` are
  deliberately not inferred: they are as often codes and counts.
- ~~Semicolon-delimited files~~ — **done in 1.2.0**. Excel writes them where the
  decimal separator is a comma.
- ~~Binary floats for decimals~~ — **done in 1.2.0**. `FLOAT`/`DOUBLE` became
  `DECIMAL(38,s)` with the sample's scale.

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
- **Idempotent DDL** — optional `DROP TABLE IF EXISTS` **done in 1.2.0**.
  `CREATE TABLE IF NOT EXISTS` (not available on SQL Server) and a transaction
  wrapper remain open.
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

- ~~Consolidate the duplicated SQL helpers~~ — **done in 1.1.6** (see Phase 0).
  The panel script is a real module and imports from `src/utils`; the claim that
  it "cannot import a module" was true of the template-literal design, not of
  webviews, and no longer applies.
- **Type-check the panel script strictly.** `tsconfig.webview.json` sets
  `strict: false` because the script was moved out of a template literal where
  it had never been type-checked at all. Roughly 900 lines of DOM access need
  annotating.
- **Test the panel script.** `src/webview/main.ts` has no unit tests. Most of
  the logic now lives in tested utils, but `renderDiff` and `doCountValues`
  still hold real behaviour. The browser harness that renders the panel is now
  committed as `scripts/render-panel.js` (it had been lost from a scratch
  directory), but it is not run in CI — that needs a headless browser.
- **Reduce the command surface.** The extension contributes 10 commands and a 7-item context submenu. New transforms now go behind `Transform Selection…` instead of adding to this; some existing entries could move there too. Consider collapsing the rarely used entries into the panel so the palette and right-click menu feel less crowded.

---

## Needs investigation

Two of the original notes have now been checked; two remain open.

### Resolved on inspection

- **"Image is not showing up."** Not reproducible on the current listing. `README.md` uses a repo-relative `<img src="images/icon.png">`, and at package time `vsce` rewrites it to `https://github.com/siddhantvirus/vscode-data-toolkit/raw/HEAD/images/icon.png` using the `repository` field, which resolves correctly on the live marketplace page. **Caveat:** this only works while the repository is public — making it private or renaming it would break the marketplace image. If the original report predates the `repository` field being added, that explains it.

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
