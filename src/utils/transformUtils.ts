/**
 * Transforms behind the "Transform Selection…" quick-pick.
 *
 * Every function here is pure — text or rows in, text or rows out — so each is
 * unit-tested directly. The command in src/transformCommand.ts only gathers
 * choices from the user and writes the result back to the editor.
 */

import { looksLikeJson, parseJsonRecords, recordsToTable } from './jsonUtils';
import { detectSeparator, isPlainNumber, joinAsDelimitedLine, parseDelimitedText } from './sqlUtils';

/**
 * Split delimited text into one value per line — the inverse of joining a list
 * into a line.
 *
 * Uses the same RFC 4180 parser as the SQL builder, so `a,"b,c",d` yields three
 * values rather than four. Several rows are flattened in reading order. Text
 * with no delimiter is returned as its non-blank lines.
 */
export function splitIntoValues(text: string): string[] {
    const firstLine = text.split(/\r?\n/).find(line => line.trim() !== '') ?? '';
    const separator = detectSeparator(firstLine);
    if (!separator) {
        return text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
    }
    return parseDelimitedText(text, separator).flat();
}

/**
 * Unwrap a SQL `IN (...)` clause back into its values.
 *
 * The inverse of building one. Accepts a whole predicate
 * (`WHERE id IN ('a','b')`), a bare parenthesised list, or just the list.
 * Quoted values are unquoted and doubled quotes undone, so `'O''Brien'`
 * becomes `O'Brien`; a T-SQL `N'...'` prefix is dropped. Commas and
 * parentheses inside quotes are part of the value.
 */
export function unwrapInClause(text: string): string[] {
    const body = extractParenthesised(text.trim());

    const values: string[] = [];
    let token = '';
    let quote: string | null = null;
    let wasQuoted = false;
    let closed = false;

    const push = () => {
        const value = wasQuoted ? token : token.trim();
        // A quoted empty string is a real value; stray blank tokens (from a
        // trailing comma) are not.
        if (wasQuoted || value !== '') {
            values.push(value);
        }
        token = '';
        wasQuoted = false;
        closed = false;
    };

    for (let i = 0; i < body.length; i++) {
        const char = body[i];

        if (quote) {
            if (char === quote) {
                if (body[i + 1] === quote) {
                    token += quote; // doubled quote inside the value
                    i++;
                } else {
                    quote = null;
                    closed = true;
                }
            } else {
                token += char;
            }
        } else if (char === ',') {
            push();
        } else if (closed) {
            // Anything between a closing quote and the next comma is spacing.
            continue;
        } else if ((char === "'" || char === '"') && /^\s*N?$/i.test(token)) {
            quote = char;
            token = '';
            wasQuoted = true;
        } else {
            token += char;
        }
    }
    push();

    if (values.length === 0) {
        throw new Error('No values found in the IN clause.');
    }
    return values;
}

/**
 * The text inside the first balanced pair of parentheses, honouring quotes.
 * Falls back to the whole text when there are no parentheses.
 */
function extractParenthesised(text: string): string {
    const open = text.indexOf('(');
    if (open === -1) {
        return text;
    }

    let depth = 0;
    let quote: string | null = null;
    for (let i = open; i < text.length; i++) {
        const char = text[i];
        if (quote) {
            if (char === quote) {
                if (text[i + 1] === quote) {
                    i++;
                } else {
                    quote = null;
                }
            }
        } else if (char === "'" || char === '"') {
            quote = char;
        } else if (char === '(') {
            depth++;
        } else if (char === ')') {
            depth--;
            if (depth === 0) {
                return text.slice(open + 1, i);
            }
        }
    }
    // Unbalanced — take everything after the opening parenthesis.
    return text.slice(open + 1);
}

/**
 * Pull one column out of a parsed table.
 *
 * A row too short to have the column contributes an empty value rather than
 * being skipped, so the output still lines up with the input rows.
 */
export function extractColumn(table: string[][], index: number, skipHeader: boolean): string[] {
    const width = table.length > 0 ? table[0].length : 0;
    if (!Number.isInteger(index) || index < 0 || index >= width) {
        throw new Error(`Column ${index + 1} does not exist; the first row has ${width}.`);
    }
    return table
        .slice(skipHeader ? 1 : 0)
        .map(row => (index < row.length ? row[index] : ''));
}

/**
 * Swap rows and columns.
 *
 * Ragged input is padded to the widest row, so no value is lost — unlike SQL
 * generation, which has to fit rows to the header and may drop fields.
 */
export function transposeTable(table: string[][]): string[][] {
    const width = table.reduce((max, row) => Math.max(max, row.length), 0);
    return Array.from({ length: width }, (_, column) =>
        table.map(row => (column < row.length ? row[column] : ''))
    );
}

/**
 * Serialise one row, quoting fields per RFC 4180 so the output can be read
 * back by the same parser without shifting columns.
 */
export function formatDelimitedRow(fields: string[], separator: string): string {
    return fields
        .map(field => {
            const needsQuotes = field.includes(separator) || /["\r\n]/.test(field);
            return needsQuotes ? `"${field.replace(/"/g, '""')}"` : field;
        })
        .join(separator);
}

/** A Markdown table's delimiter row, e.g. `| --- | :---: | ---: |`. */
const MARKDOWN_DELIMITER_ROW = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/;

/**
 * Whether text is a Markdown table: a pipe-separated first line followed by a
 * delimiter row. The delimiter row is what tells it apart from plain
 * pipe-separated data, which has none.
 */
export function isMarkdownTable(text: string): boolean {
    const [first, second] = text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
    return first !== undefined && first.includes('|')
        && second !== undefined && second.includes('|') && MARKDOWN_DELIMITER_ROW.test(second);
}

/**
 * Parse a Markdown table into rows, header first.
 *
 * The delimiter row is dropped, `\|` is a literal pipe, and `<br>` becomes a
 * line break — the reverse of {@link tableToMarkdown}.
 */
export function parseMarkdownTable(text: string): string[][] {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
    return lines
        .filter((_, index) => index !== 1)
        .map(line => {
            const cells: string[] = [];
            let cell = '';
            for (let i = 0; i < line.length; i++) {
                if (line[i] === '\\' && line[i + 1] === '|') {
                    cell += '|';
                    i++;
                } else if (line[i] === '|') {
                    cells.push(cell);
                    cell = '';
                } else {
                    cell += line[i];
                }
            }
            cells.push(cell);
            // Leading and trailing pipes are optional and enclose nothing.
            if (line.startsWith('|')) { cells.shift(); }
            if (line.endsWith('|') && !line.endsWith('\\|')) { cells.pop(); }
            return cells.map(value => value.trim().replace(/<br\s*\/?>/gi, '\n'));
        });
}

/**
 * Format rows as a Markdown table, header first.
 *
 * Columns are padded so the source reads as a table too, and a column whose
 * values are all numbers is right-aligned. Short rows are padded rather than
 * dropped. Pipes are escaped and line breaks become `<br>`, so a cell cannot
 * break the table apart.
 */
export function tableToMarkdown(table: string[][]): string {
    const width = table.reduce((max, row) => Math.max(max, row.length), 0);
    if (width === 0) {
        throw new Error('The selection has no rows.');
    }

    const cells = table.map(row =>
        Array.from({ length: width }, (_, column) =>
            (column < row.length ? row[column] : '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
        )
    );

    const numeric = Array.from({ length: width }, (_, column) => {
        const values = cells.slice(1).map(row => row[column].trim()).filter(value => value !== '');
        return values.length > 0 && values.every(isPlainNumber);
    });
    const widths = Array.from({ length: width }, (_, column) =>
        Math.max(3, ...cells.map(row => row[column].length))
    );

    const line = (row: string[]) =>
        '| ' + row.map((value, column) =>
            numeric[column] ? value.padStart(widths[column]) : value.padEnd(widths[column])
        ).join(' | ') + ' |';
    const delimiter = '| ' + widths.map((size, column) =>
        numeric[column] ? '-'.repeat(size - 1) + ':' : '-'.repeat(size)
    ).join(' | ') + ' |';

    return [line(cells[0]), delimiter, ...cells.slice(1).map(line)].join('\n');
}

export type StructuredFormat = 'json' | 'markdown';

export interface StructuredTable {
    table: string[][];
    format: StructuredFormat;
    /** Something worth telling the user about how the input was read, if anything. */
    note?: string;
}

/** Which structured format text is in, without parsing it; null for delimited text. */
export function detectStructuredFormat(text: string): StructuredFormat | null {
    if (looksLikeJson(text)) {
        return 'json';
    }
    return isMarkdownTable(text) ? 'markdown' : null;
}

/**
 * Read JSON (array, object or NDJSON) or a Markdown table as rows, header
 * first. Returns null for anything else, so the caller falls back to
 * delimited parsing.
 *
 * Every table-shaped feature goes through this, which is how the SQL builder,
 * the generate command and the transforms all accept JSON without each
 * learning about it separately.
 */
export function parseStructuredTable(text: string): StructuredTable | null {
    const format = detectStructuredFormat(text);
    if (format === 'json') {
        const { records, path } = parseJsonRecords(text);
        const table = recordsToTable(records);
        const count = `${records.length} JSON record${records.length === 1 ? '' : 's'}`;
        return {
            table,
            format,
            note: path === '$' ? `Read ${count}.` : `Read ${count} from ${path}.`
        };
    }
    if (format === 'markdown') {
        return { table: parseMarkdownTable(text), format };
    }
    return null;
}

export interface ChunkedInClauseOptions {
    /** The column being matched, written as given. */
    column: string;
    /** Maximum values per IN list; Oracle rejects more than 1000. */
    chunkSize: number;
}

/**
 * Build `column IN (...)` for a list too long for one IN, splitting it into
 * OR'd chunks.
 *
 * Oracle rejects an IN list longer than 1000 expressions (ORA-01795), and other
 * engines degrade on very long literal lists. Values are quoted unless every
 * one is an unambiguous number — a zero-padded id such as 007 stays quoted, as
 * it does everywhere else in the extension.
 */
export function buildChunkedInClause(values: string[], options: ChunkedInClauseOptions): string {
    const { column, chunkSize } = options;

    if (!column.trim()) {
        throw new Error('A column name is required.');
    }
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
        throw new Error('Chunk size must be a whole number of at least 1.');
    }

    const cleaned = values.map(v => v.trim()).filter(v => v !== '');
    if (cleaned.length === 0) {
        throw new Error('No values to match.');
    }

    const enclosure = cleaned.every(isPlainNumber) ? '' : "'";

    const clauses: string[] = [];
    for (let start = 0; start < cleaned.length; start += chunkSize) {
        const list = joinAsDelimitedLine(cleaned.slice(start, start + chunkSize), {
            separator: ', ',
            enclosure,
            sqlInClause: false
        });
        clauses.push(`${column} IN (${list})`);
    }

    // One chunk needs no grouping; several are OR'd and wrapped so the result
    // is safe to AND with other predicates.
    return clauses.length === 1
        ? clauses[0]
        : `(${clauses.join('\n OR ')})`;
}
