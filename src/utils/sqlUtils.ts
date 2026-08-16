/**
 * Shared SQL utility functions for the Data Toolkit extension
 */

/** Date literal, e.g. 2024-03-15 or 2024/3/5 */
export const DATE_PATTERN = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/;

/**
 * Timestamp literal. Covers the shapes machines actually emit: optional
 * seconds, optional fractional seconds, and an optional Z or ±HH:MM offset,
 * so full ISO-8601 such as 2024-03-15T09:30:00.123Z is recognised.
 */
export const TIMESTAMP_PATTERN =
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}[T\s]\d{1,2}:\d{1,2}(:\d{1,2}(\.\d{1,9})?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Split one line of delimited text, honouring RFC 4180 quoting.
 *
 * A plain `split()` corrupts any field containing the delimiter — the very
 * common `1,"Smith, John",NYC` becomes four fields instead of three.
 *
 * Quoting only applies to single-character delimiters; space-aligned columns
 * (a RegExp separator) have no quoting convention, so those fall back to split.
 *
 * Note: this is line-scoped, so a quoted field containing a newline is still
 * not supported — that requires parsing the whole document rather than
 * splitting on lines first.
 */
export function parseDelimitedLine(line: string, separator: string | RegExp): string[] {
    if (separator instanceof RegExp || separator.length !== 1) {
        return line.split(separator).map(field => field.trim());
    }

    const fields: string[] = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (inQuotes) {
            if (char === '"') {
                if (line[i + 1] === '"') {
                    field += '"'; // escaped quote inside a quoted field
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += char;
            }
        } else if (char === '"' && field.trim() === '') {
            // A quote only opens a field at the start of that field.
            inQuotes = true;
            field = '';
        } else if (char === separator) {
            fields.push(field.trim());
            field = '';
        } else {
            field += char;
        }
    }

    fields.push(field.trim());
    return fields;
}

/**
 * Turn raw headers into valid, unique SQL identifiers.
 *
 * Handles what spreadsheet exports actually produce: punctuation, leading
 * digits (illegal unquoted in every dialect), blanks, and repeats — duplicate
 * column names are rejected outright by every engine.
 */
export function sanitizeColumnNames(headers: string[]): string[] {
    const seen = new Map<string, number>();

    return headers.map((header, index) => {
        let name = String(header ?? '')
            .trim()
            .replace(/[^a-zA-Z0-9_]+/g, '_')
            .replace(/^_+|_+$/g, '');

        if (!name) {
            name = `column${index + 1}`;
        }
        if (/^\d/.test(name)) {
            name = `col_${name}`;
        }

        // Compare case-insensitively: most engines treat identifiers that way.
        const key = name.toLowerCase();
        const count = seen.get(key) ?? 0;
        seen.set(key, count + 1);

        return count === 0 ? name : `${name}_${count + 1}`;
    });
}

/**
 * Decimal integers and decimals only — no leading zeros, hex, exponents or
 * Infinity. Anything outside this set is safer to emit as a quoted string.
 */
const PLAIN_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Whether a value should be treated as a SQL numeric literal.
 */
export function isPlainNumber(value: string): boolean {
    return PLAIN_NUMBER_PATTERN.test(value.trim());
}

/**
 * Format SQL value based on its content
 * @param value The value to format
 * @param inferDataTypes Whether to infer data types
 * @returns The formatted SQL value
 */
export function formatSqlValue(value: string, inferDataTypes: boolean): string {
    if (!value || value.trim() === '') {
        return 'NULL';
    }

    // Emit unquoted numeric literals only for values that are unambiguously
    // numeric. Number() is far too permissive here: it accepts '0x1F', '1e5',
    // 'Infinity' and — most damaging for real data — '00123', which would be
    // silently written as 123 and lose the leading zeros of ids and zip codes.
    if (inferDataTypes && isPlainNumber(value)) {
        return value;
    }

    // Dates and timestamps are quoted string literals in every dialect we emit.
    if (inferDataTypes && (DATE_PATTERN.test(value) || TIMESTAMP_PATTERN.test(value))) {
        return `'${value}'`;
    }

    // Escape single quotes
    const escaped = value.replace(/'/g, "''");
    return `'${escaped}'`;
}

/**
 * Get default data type for a SQL dialect
 * @param dialect The SQL dialect
 * @returns The default data type for the dialect
 */
export function getDefaultDataType(dialect: string): string {
    switch (dialect) {
        case 'mssql': return 'VARCHAR(255)';
        case 'mysql': return 'VARCHAR(255)';
        case 'postgres': return 'VARCHAR(255)';
        case 'spark': return 'STRING';
        default: return 'VARCHAR(255)';
    }
}

/**
 * Infer SQL data type based on sample data
 * @param sampleData Sample data rows
 * @param columnIndex Column index to check
 * @param dialect SQL dialect
 * @returns Inferred SQL data type
 */
/**
 * How VARCHAR column widths are chosen.
 * - `fixed`: always VARCHAR(255). Safe default — generated DDL cannot be too
 *   narrow for data that was not in the pasted sample.
 * - `fromSample`: size to the widest sampled value, with headroom. Tighter
 *   schemas, but only sound when the sample covers the real value range.
 */
export type VarcharSizing = 'fixed' | 'fromSample';

export function inferSqlDataType(
    sampleData: string[][],
    columnIndex: number,
    dialect: string,
    varcharSizing: VarcharSizing = 'fixed'
): string {
    // Check sample values to infer the data type
    const sampleValues = sampleData
        .map(row => columnIndex < row.length ? row[columnIndex] : '')
        .filter(value => value !== null && value !== undefined && value.trim() !== '');
    
    if (sampleValues.length === 0) {
        return getDefaultDataType(dialect);
    }

    // Scan every value: an early exit here would leave maxLength short and
    // could size the VARCHAR too small for rows later in the column.
    let allNumbers = true;
    let allIntegers = true;
    let maxLength = 0;

    for (const value of sampleValues) {
        maxLength = Math.max(maxLength, value.length);

        if (!isPlainNumber(value)) {
            allNumbers = false;
            allIntegers = false;
        } else if (!Number.isInteger(Number(value))) {
            allIntegers = false;
        }
    }

    const allDates = sampleValues.every(value => DATE_PATTERN.test(value));
    const allTimestamps = sampleValues.every(value => TIMESTAMP_PATTERN.test(value));

    // Only size from the sample when explicitly asked. A paste is usually a
    // subset of the real data, so a width derived from it can be too narrow.
    const varcharSize = varcharSizing === 'fromSample'
        ? Math.min(255, Math.max(10, Math.ceil(maxLength * 1.5 / 10) * 10))
        : 255;

    switch (dialect) {
        case 'mssql':
            if (allTimestamps) { return 'DATETIME'; }
            if (allDates) { return 'DATE'; }
            if (allIntegers) { return 'INT'; }
            if (allNumbers) { return 'FLOAT'; }
            return maxLength <= 255 ? `VARCHAR(${varcharSize})` : 'TEXT';

        case 'mysql':
            if (allTimestamps) { return 'DATETIME'; }
            if (allDates) { return 'DATE'; }
            if (allIntegers) { return 'INT'; }
            if (allNumbers) { return 'FLOAT'; }
            return maxLength <= 255 ? `VARCHAR(${varcharSize})` : 'TEXT';

        case 'postgres':
            if (allTimestamps) { return 'TIMESTAMP'; }
            if (allDates) { return 'DATE'; }
            if (allIntegers) { return 'INTEGER'; }
            if (allNumbers) { return 'DECIMAL'; }
            return maxLength <= 255 ? `VARCHAR(${varcharSize})` : 'TEXT';

        case 'spark':
            if (allTimestamps) { return 'TIMESTAMP'; }
            if (allDates) { return 'DATE'; }
            if (allIntegers) { return 'INT'; }
            if (allNumbers) { return 'DOUBLE'; }
            return 'STRING';
    }

    return getDefaultDataType(dialect);
}

/**
 * Detect the separator used in data.
 *
 * Returns a value suitable for passing straight to String.prototype.split.
 * Space-aligned columns yield a RegExp matching runs of two or more spaces —
 * splitting those on a single space would break every word into its own column.
 *
 * @param line A sample line to check for separators
 * @returns The detected separator or null if none is found
 */
export function detectSeparator(line: string): string | RegExp | null {
    if (!line) {
        return null;
    }

    if (line.includes('\t')) {
        return '\t'; // Tab has highest priority if present
    }
    if (line.includes(',')) {
        return ',';  // Comma is very common for CSV data
    }
    if (line.includes('|')) {
        return '|';  // Pipe for markdown tables
    }
    if (/\s{2,}/.test(line)) {
        return /\s{2,}/; // Space-aligned columns
    }

    return null;
}
