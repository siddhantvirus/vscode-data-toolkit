/**
 * Keyed row diff for tabular data.
 *
 * Set operations over whole rows cannot express "changed": a row with one
 * altered field appears in both "only in A" and "only in B", which is true but
 * useless. Matching rows by key gives a fourth outcome and lets the specific
 * differing fields be reported. It also aligns columns by header name rather
 * than position, so reordered columns are not read as wholesale changes.
 */

export type RowStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export interface RowDiffOptions {
    /** Compare values case-sensitively. Default true. */
    caseSensitive?: boolean;
    /** Trim surrounding whitespace before comparing. Default true. */
    trim?: boolean;
}

export interface CellChange {
    column: string;
    before: string;
    after: string;
}

export interface DiffRow {
    key: string;
    status: RowStatus;
    /** Values keyed by column name. Absent on the side where the row is missing. */
    before?: Record<string, string>;
    after?: Record<string, string>;
    /** Populated only when status is 'changed'. */
    changes: CellChange[];
}

export interface RowDiffResult {
    rows: DiffRow[];
    counts: Record<RowStatus, number>;
    /** Display order: key first, then shared columns, then A-only, then B-only. */
    columns: string[];
    /** Ambiguities and schema drift the caller should surface, not swallow. */
    warnings: string[];
}

/** A table as parsed: first entry is the header row. */
type Table = string[][];

function toRecords(table: Table): { headers: string[]; records: Record<string, string>[] } {
    const headers = table.length > 0 ? table[0] : [];
    const records = table.slice(1).map(row => {
        const record: Record<string, string> = {};
        headers.forEach((header, i) => {
            record[header] = i < row.length ? row[i] : '';
        });
        return record;
    });
    return { headers, records };
}

function normalise(value: string, options: Required<RowDiffOptions>): string {
    let out = value ?? '';
    if (options.trim) {
        out = out.trim();
    }
    if (!options.caseSensitive) {
        out = out.toLowerCase();
    }
    return out;
}

/**
 * Suggest a key column: the leftmost column present in both tables whose values
 * are unique and non-empty on both sides. Returns null when nothing qualifies,
 * in which case the caller should ask rather than guess.
 */
export function suggestKeyColumn(tableA: Table, tableB: Table): string | null {
    const a = toRecords(tableA);
    const b = toRecords(tableB);
    const shared = a.headers.filter(h => b.headers.includes(h));

    const isUniqueKey = (records: Record<string, string>[], column: string) => {
        const seen = new Set<string>();
        for (const record of records) {
            const value = (record[column] ?? '').trim();
            if (value === '' || seen.has(value)) {
                return false;
            }
            seen.add(value);
        }
        return records.length > 0;
    };

    return shared.find(h => isUniqueKey(a.records, h) && isUniqueKey(b.records, h)) ?? null;
}

/**
 * Diff two tables by key.
 *
 * Only columns present in both tables are compared; columns unique to one side
 * are reported as warnings rather than making every row look changed.
 */
export function diffRows(
    tableA: Table,
    tableB: Table,
    keyColumn: string,
    options: RowDiffOptions = {}
): RowDiffResult {
    const opts: Required<RowDiffOptions> = {
        caseSensitive: options.caseSensitive ?? true,
        trim: options.trim ?? true
    };

    const a = toRecords(tableA);
    const b = toRecords(tableB);
    const warnings: string[] = [];

    if (!a.headers.includes(keyColumn) || !b.headers.includes(keyColumn)) {
        return {
            rows: [],
            counts: { added: 0, removed: 0, changed: 0, unchanged: 0 },
            columns: [],
            warnings: [`Key column "${keyColumn}" is not present in both tables.`]
        };
    }

    // Schema drift is reported, not treated as every row differing.
    const onlyInA = a.headers.filter(h => !b.headers.includes(h));
    const onlyInB = b.headers.filter(h => !a.headers.includes(h));
    if (onlyInA.length) {
        warnings.push(`Column${onlyInA.length > 1 ? 's' : ''} only in A: ${onlyInA.join(', ')} — not compared.`);
    }
    if (onlyInB.length) {
        warnings.push(`Column${onlyInB.length > 1 ? 's' : ''} only in B: ${onlyInB.join(', ')} — not compared.`);
    }

    const comparedColumns = a.headers.filter(h => h !== keyColumn && b.headers.includes(h));

    // A duplicated key makes the pairing ambiguous — say so rather than
    // silently keeping whichever row happened to be last.
    const index = (records: Record<string, string>[], side: string) => {
        const map = new Map<string, Record<string, string>>();
        const duplicates = new Set<string>();
        for (const record of records) {
            const key = normalise(record[keyColumn] ?? '', opts);
            if (map.has(key)) {
                duplicates.add(key);
            }
            map.set(key, record);
        }
        if (duplicates.size) {
            warnings.push(
                `${duplicates.size} duplicate key${duplicates.size > 1 ? 's' : ''} in ${side} ` +
                `(${[...duplicates].slice(0, 3).join(', ')}${duplicates.size > 3 ? ', …' : ''}) — ` +
                `only the last row for each was compared.`
            );
        }
        return map;
    };

    const mapA = index(a.records, 'A');
    const mapB = index(b.records, 'B');

    const counts: Record<RowStatus, number> = { added: 0, removed: 0, changed: 0, unchanged: 0 };
    const rows: DiffRow[] = [];

    // A's order first, then keys new to B, so the output reads like the source.
    const keys: string[] = [];
    for (const key of mapA.keys()) {
        keys.push(key);
    }
    for (const key of mapB.keys()) {
        if (!mapA.has(key)) {
            keys.push(key);
        }
    }

    for (const key of keys) {
        const before = mapA.get(key);
        const after = mapB.get(key);
        const display = (before ?? after)?.[keyColumn] ?? key;

        if (before && !after) {
            counts.removed++;
            rows.push({ key: display, status: 'removed', before, changes: [] });
            continue;
        }
        if (!before && after) {
            counts.added++;
            rows.push({ key: display, status: 'added', after, changes: [] });
            continue;
        }
        if (!before || !after) {
            continue;
        }

        const changes: CellChange[] = [];
        for (const column of comparedColumns) {
            const beforeValue = before[column] ?? '';
            const afterValue = after[column] ?? '';
            if (normalise(beforeValue, opts) !== normalise(afterValue, opts)) {
                changes.push({ column, before: beforeValue, after: afterValue });
            }
        }

        if (changes.length) {
            counts.changed++;
            rows.push({ key: display, status: 'changed', before, after, changes });
        } else {
            counts.unchanged++;
            rows.push({ key: display, status: 'unchanged', before, after, changes: [] });
        }
    }

    return {
        rows,
        counts,
        columns: [keyColumn, ...comparedColumns, ...onlyInA, ...onlyInB],
        warnings
    };
}
