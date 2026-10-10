import * as vscode from 'vscode';
import { extractJsonPath, parseJsonDocument, tableToJson } from './utils/jsonUtils';
import {
    applyTemplate,
    changeCase,
    dedupeByColumn,
    extractMatches,
    filterLines,
    normaliseWhitespace,
    parseUserRegExp,
    sortLines,
    toLines
} from './utils/listUtils';
import { describeRaggedRows, detectSeparator, findRaggedRows, parseDelimitedText } from './utils/sqlUtils';
import {
    buildChunkedInClause,
    extractColumn,
    formatDelimitedRow,
    parseStructuredTable,
    splitIntoValues,
    tableToMarkdown,
    transposeTable,
    unwrapInClause
} from './utils/transformUtils';

/**
 * A transform offered in the quick-pick. `run` returns the replacement text, or
 * undefined when the user cancelled one of its follow-up prompts.
 */
interface Transform extends vscode.QuickPickItem {
    run(text: string, eol: string): Promise<string | undefined>;
}

type PickItem = Transform | vscode.QuickPickItem;

function group(label: string): vscode.QuickPickItem {
    return { label, kind: vscode.QuickPickItemKind.Separator };
}

interface ReadTable {
    table: string[][];
    /** Separator to write the table back with. */
    separator: string;
    /** Whether the first row is certainly a header — true for JSON and Markdown. */
    hasHeader: boolean;
}

/**
 * Parse the selection as a table — JSON, a Markdown table, or delimited text —
 * failing with a message the user can act on when it is none of those.
 */
function readTable(text: string): ReadTable {
    const structured = parseStructuredTable(text);
    if (structured) {
        if (structured.note) {
            vscode.window.setStatusBarMessage(structured.note, 5000);
        }
        return { table: structured.table, separator: ',', hasHeader: true };
    }

    const firstLine = text.split(/\r?\n/).find(line => line.trim() !== '') ?? '';
    const separator = detectSeparator(firstLine);
    if (!separator) {
        throw new Error('No delimiter found. Select tabular data separated by tabs, commas or pipes, a Markdown table, or JSON.');
    }
    const table = parseDelimitedText(text, separator);
    if (table.length === 0) {
        throw new Error('The selection has no rows.');
    }
    // Space-aligned columns cannot be written back with a run of spaces, so
    // they come out tab-separated.
    return { table, separator: typeof separator === 'string' ? separator : '\t', hasHeader: false };
}

/**
 * Ask before converting rows that do not match the header to a keyed format,
 * where extra fields have no key to go under and are dropped.
 */
async function confirmRagged(table: string[][]): Promise<boolean> {
    const { expected, ragged } = findRaggedRows(table);
    if (ragged.length === 0) {
        return true;
    }
    const choice = await vscode.window.showWarningMessage(
        'Some rows do not match the header',
        { modal: true, detail: describeRaggedRows(ragged, expected) },
        'Convert Anyway'
    );
    return choice === 'Convert Anyway';
}

/** Ask for a regular expression, validating it as it is typed. */
function askForRegExp(prompt: string, placeHolder: string): Thenable<string | undefined> {
    return vscode.window.showInputBox({
        prompt,
        placeHolder,
        validateInput: value => {
            if (!value) {
                return 'Enter a pattern';
            }
            try {
                parseUserRegExp(value);
                return null;
            } catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
        }
    });
}

const TRANSFORMS: PickItem[] = [
    group('Lists'),
    {
        label: '$(sort-precedence) Sort lines',
        description: 'Natural, numeric, by length, or reversed',
        detail: 'Natural order puts item2 before item10. Blank lines are removed.',
        async run(text, eol) {
            const mode = await vscode.window.showQuickPick(
                [
                    { label: 'A → Z', description: 'natural: item2 before item10, ignoring case', mode: 'natural' as const },
                    { label: 'Z → A', description: 'natural, descending', mode: 'naturalDesc' as const },
                    { label: 'Smallest number first', description: 'non-numbers follow, A → Z', mode: 'numeric' as const },
                    { label: 'Largest number first', description: 'non-numbers follow, A → Z', mode: 'numericDesc' as const },
                    { label: 'Shortest first', description: 'by length', mode: 'length' as const },
                    { label: 'Reverse', description: 'flip the current order without sorting', mode: 'reverse' as const }
                ],
                { placeHolder: 'Sort order' }
            );
            return mode && sortLines(toLines(text), mode.mode).join(eol);
        }
    },
    {
        label: '$(case-sensitive) Change case',
        description: 'UPPER, lower, Title, snake_case, camelCase, …',
        detail: 'Applied to each line. snake_case turns "Total Sales (USD)" into total_sales_usd.',
        async run(text, eol) {
            const mode = await vscode.window.showQuickPick(
                [
                    { label: 'UPPER CASE', mode: 'upper' as const },
                    { label: 'lower case', mode: 'lower' as const },
                    { label: 'Title Case', mode: 'title' as const },
                    { label: 'snake_case', mode: 'snake' as const },
                    { label: 'camelCase', mode: 'camel' as const },
                    { label: 'PascalCase', mode: 'pascal' as const },
                    { label: 'kebab-case', mode: 'kebab' as const },
                    { label: 'CONSTANT_CASE', mode: 'constant' as const }
                ],
                { placeHolder: 'Case' }
            );
            return mode && toLines(text).map(line => changeCase(line, mode.mode)).join(eol);
        }
    },
    {
        label: '$(whitespace) Clean up whitespace',
        description: 'Trim lines, collapse spaces, remove blank lines',
        detail: 'Choose any combination; all three are selected to start with.',
        async run(text, eol) {
            const picked = await vscode.window.showQuickPick(
                [
                    { label: 'Trim each line', key: 'trim' as const, picked: true },
                    { label: 'Collapse runs of spaces and tabs', key: 'collapse' as const, picked: true },
                    { label: 'Remove blank lines', key: 'dropBlank' as const, picked: true }
                ],
                { placeHolder: 'Clean-ups to apply', canPickMany: true }
            );
            if (!picked) {
                return undefined;
            }
            const chosen = new Set(picked.map(item => item.key));
            return normaliseWhitespace(toLines(text), {
                trim: chosen.has('trim'),
                collapse: chosen.has('collapse'),
                dropBlank: chosen.has('dropBlank')
            }).join(eol);
        }
    },
    {
        label: '$(bracket) Wrap each line',
        description: "Template per line: '{}', → 'value',",
        detail: '{} stands for the line. Add a prefix, a suffix, or both.',
        async run(text, eol) {
            const template = await vscode.window.showInputBox({
                prompt: 'Template for each line — {} is the line',
                value: "'{}',",
                validateInput: value => value.includes('{}') ? null : 'Include {} where the line goes'
            });
            return template === undefined ? undefined : applyTemplate(toLines(text), template).join(eol);
        }
    },
    {
        label: '$(filter) Keep or remove lines matching a pattern',
        description: 'Filter by regular expression',
        detail: 'Type a pattern, or /pattern/i for case-insensitive.',
        async run(text, eol) {
            const action = await vscode.window.showQuickPick(
                [
                    { label: 'Keep matching lines', keep: true },
                    { label: 'Remove matching lines', keep: false }
                ],
                { placeHolder: 'Keep or remove?' }
            );
            if (!action) {
                return undefined;
            }
            const pattern = await askForRegExp('Lines to ' + (action.keep ? 'keep' : 'remove'), 'e.g. ^ERROR or /timeout/i');
            return pattern === undefined ? undefined : filterLines(toLines(text), parseUserRegExp(pattern), action.keep).join(eol);
        }
    },
    {
        label: '$(regex) Extract matches of a pattern',
        description: 'Pull ids, emails or codes out of free text',
        detail: 'Each match on its own line. With capture groups, the groups are returned, tab-separated.',
        async run(text, eol) {
            const pattern = await askForRegExp('Pattern to extract', 'e.g. [\\w.+-]+@[\\w-]+\\.[\\w.]+ or order #(\\d+)');
            if (pattern === undefined) {
                return undefined;
            }
            const matches = extractMatches(text, parseUserRegExp(pattern));
            if (matches.length === 0) {
                throw new Error('Nothing in the selection matches that pattern.');
            }
            return matches.join(eol);
        }
    },
    {
        label: '$(list-unordered) Unwrap IN (...) into a list',
        description: "IN ('a','b') → a, b on separate lines",
        detail: "Undoes quoting, so 'O''Brien' becomes O'Brien. Accepts a whole WHERE predicate.",
        async run(text, eol) {
            return unwrapInClause(text).join(eol);
        }
    },
    {
        label: '$(split-vertical) Split a delimited row into lines',
        description: 'a,b,c → a, b, c on separate lines',
        detail: 'Quote-aware: "b,c" stays one value.',
        async run(text, eol) {
            return splitIntoValues(text).join(eol);
        }
    },
    {
        label: '$(symbol-array) Build a chunked IN clause',
        description: 'For lists longer than Oracle’s 1000-item limit',
        detail: 'One value per line in, (col IN (...) OR col IN (...)) out.',
        async run(text, eol) {
            const column = await vscode.window.showInputBox({
                prompt: 'Column to match',
                placeHolder: 'customer_id',
                validateInput: value => value.trim() ? null : 'Enter a column name'
            });
            if (column === undefined) {
                return undefined;
            }

            const size = await vscode.window.showInputBox({
                prompt: 'Maximum values per IN (...) — Oracle rejects more than 1000',
                value: '1000',
                validateInput: value => /^[1-9]\d*$/.test(value.trim()) ? null : 'Enter a whole number of at least 1'
            });
            if (size === undefined) {
                return undefined;
            }

            return buildChunkedInClause(text.split(/\r?\n/), {
                column: column.trim(),
                chunkSize: Number(size.trim())
            }).split('\n').join(eol);
        }
    },

    group('Tables'),
    {
        label: '$(symbol-field) Extract a column',
        description: 'Keep one column of tabular data or JSON',
        detail: 'Useful for turning one column of a pasted table into an IN list.',
        async run(text, eol) {
            const { table, hasHeader } = readTable(text);

            const column = await vscode.window.showQuickPick(
                table[0].map((value, index) => ({
                    label: value.trim() || `(column ${index + 1})`,
                    description: `column ${index + 1}`,
                    index
                })),
                { placeHolder: 'Which column?' }
            );
            if (!column) {
                return undefined;
            }

            let skipHeader = true;
            if (!hasHeader) {
                const header = await vscode.window.showQuickPick(
                    ['Yes — leave it out', 'No — the first row is data'],
                    { placeHolder: 'Is the first row a header?' }
                );
                if (!header) {
                    return undefined;
                }
                skipHeader = header.startsWith('Yes');
            }

            return extractColumn(table, column.index, skipHeader).join(eol);
        }
    },
    {
        label: '$(fold) Remove duplicate rows by a key column',
        description: 'Keep the first or last row for each key',
        detail: 'Rows count as duplicates when the key matches, even if other columns differ.',
        async run(text, eol) {
            const { table, separator, hasHeader: knownHeader } = readTable(text);

            const column = await vscode.window.showQuickPick(
                table[0].map((value, index) => ({
                    label: value.trim() || `(column ${index + 1})`,
                    description: `column ${index + 1}`,
                    index
                })),
                { placeHolder: 'Key column' }
            );
            if (!column) {
                return undefined;
            }

            const keep = await vscode.window.showQuickPick(
                [
                    { label: 'Keep the first row for each key', keep: 'first' as const },
                    { label: 'Keep the last row for each key', description: 'e.g. the latest in an append-only export', keep: 'last' as const }
                ],
                { placeHolder: 'Which row to keep?' }
            );
            if (!keep) {
                return undefined;
            }

            let hasHeader = knownHeader;
            if (!knownHeader) {
                const header = await vscode.window.showQuickPick(
                    ['Yes — keep it at the top', 'No — the first row is data'],
                    { placeHolder: 'Is the first row a header?' }
                );
                if (!header) {
                    return undefined;
                }
                hasHeader = header.startsWith('Yes');
            }

            const result = dedupeByColumn(table, column.index, keep.keep, hasHeader);
            const removed = table.length - result.length;
            vscode.window.setStatusBarMessage(`Removed ${removed} duplicate row${removed === 1 ? '' : 's'}.`, 5000);
            return result.map(row => formatDelimitedRow(row, separator)).join(eol);
        }
    },
    {
        label: '$(arrow-swap) Transpose rows and columns',
        description: 'Rows become columns',
        detail: 'Short rows are padded, so no value is lost.',
        async run(text, eol) {
            const { table, separator } = readTable(text);
            return transposeTable(table)
                .map(row => formatDelimitedRow(row, separator))
                .join(eol);
        }
    },
    {
        label: '$(table) Convert to CSV or TSV',
        description: 'From JSON, NDJSON or a Markdown table',
        detail: 'Nested objects become dotted columns (address.city); arrays stay as JSON in one cell.',
        async run(text, eol) {
            const { table } = readTable(text);
            const format = await vscode.window.showQuickPick(
                [
                    { label: 'CSV', description: 'comma-separated', separator: ',' },
                    { label: 'TSV', description: 'tab-separated — pastes straight into a spreadsheet', separator: '\t' }
                ],
                { placeHolder: 'Output format' }
            );
            if (!format) {
                return undefined;
            }
            return table.map(row => formatDelimitedRow(row, format.separator)).join(eol);
        }
    },
    {
        label: '$(markdown) Convert to a Markdown table',
        description: 'From tabular data or JSON',
        detail: 'For pull requests, issues and docs. Numeric columns are right-aligned.',
        async run(text, eol) {
            const { table } = readTable(text);
            return tableToMarkdown(table).split('\n').join(eol);
        }
    },

    group('JSON'),
    {
        label: '$(json) Convert a table to JSON',
        description: 'Header row becomes the keys',
        detail: 'As a JSON array or NDJSON. Numbers, true/false and empty values become JSON types; 007 stays a string.',
        async run(text, eol) {
            const { table } = readTable(text);
            if (!await confirmRagged(table)) {
                return undefined;
            }

            const format = await vscode.window.showQuickPick(
                [
                    { label: 'JSON array', description: 'pretty-printed', value: 'array' as const },
                    { label: 'NDJSON', description: 'one record per line — for bulk loaders and log tools', value: 'ndjson' as const }
                ],
                { placeHolder: 'Output format' }
            );
            if (!format) {
                return undefined;
            }

            const types = await vscode.window.showQuickPick(
                [
                    { label: 'Infer types', description: '42 → 42, true → true, empty → null', infer: true },
                    { label: 'Keep everything as text', description: '42 → "42"', infer: false }
                ],
                { placeHolder: 'Value types' }
            );
            if (!types) {
                return undefined;
            }

            return tableToJson(table, format.value, types.infer).split('\n').join(eol);
        }
    },
    {
        label: '$(filter) Extract a JSON field into a list',
        description: '$.items[*].id → one value per line',
        detail: 'A name applied to an array applies to every element, so plain "id" lists every record’s id.',
        async run(text, eol) {
            const root = parseJsonDocument(text);
            const path = await vscode.window.showInputBox({
                prompt: 'Path to the values — e.g. id, $.data[*].id, items[0].tags',
                value: '$',
                valueSelection: [1, 1],
                validateInput: value => value.trim() ? null : 'Enter a path'
            });
            if (path === undefined) {
                return undefined;
            }

            const { values, missing } = extractJsonPath(root, path);
            if (values.length === 0) {
                throw new Error(`Nothing found at ${path.trim()}.`);
            }
            if (missing > 0) {
                vscode.window.showInformationMessage(
                    `Extracted ${values.length} value${values.length === 1 ? '' : 's'}; ` +
                    `${missing} place${missing === 1 ? ' had' : 's had'} no value or null and ${missing === 1 ? 'was' : 'were'} skipped.`
                );
            }
            return values.join(eol);
        }
    }
];

/**
 * One command in front of every transform.
 *
 * The extension already contributes nine commands; giving each transform its
 * own would take it past forty. A quick-pick adds a single entry and filters as
 * the user types, so new transforms cost no palette or menu space.
 */
export function registerTransformCommand(): vscode.Disposable {
    return vscode.commands.registerTextEditorCommand('list-to-csv.transform', async (editor) => {
        const selection = editor.selection;
        if (selection.isEmpty) {
            vscode.window.showInformationMessage('Select the text to transform first.');
            return;
        }
        const text = editor.document.getText(selection);
        const eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

        const transform = await vscode.window.showQuickPick(TRANSFORMS, {
            placeHolder: 'Transform the selection…',
            matchOnDescription: true,
            matchOnDetail: true
        });
        if (!transform || !('run' in transform)) {
            return;
        }

        try {
            let result = await transform.run(text, eol);
            if (result === undefined) {
                return;
            }
            // Whole-line selections end in a newline; keep it, so the line
            // after the selection is not pulled up onto the last result line.
            if (/\n$/.test(text) && !/\n$/.test(result)) {
                result += eol;
            }
            // editor.edit rather than the command's edit builder: the builder
            // is only valid synchronously, and the prompts above are awaited.
            await editor.edit(builder => builder.replace(selection, result));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(message);
        }
    });
}
