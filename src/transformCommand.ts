import * as vscode from 'vscode';
import { detectSeparator, parseDelimitedText } from './utils/sqlUtils';
import {
    buildChunkedInClause,
    extractColumn,
    formatDelimitedRow,
    splitIntoValues,
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

/**
 * Parse the selection as a table, failing with a message the user can act on
 * when there is no delimiter to split on.
 */
function readTable(text: string): { table: string[][]; separator: string } {
    const firstLine = text.split(/\r?\n/).find(line => line.trim() !== '') ?? '';
    const separator = detectSeparator(firstLine);
    if (!separator) {
        throw new Error('No delimiter found. Select tabular data separated by tabs, commas or pipes.');
    }
    const table = parseDelimitedText(text, separator);
    if (table.length === 0) {
        throw new Error('The selection has no rows.');
    }
    // Space-aligned columns cannot be written back with a run of spaces, so
    // they come out tab-separated.
    return { table, separator: typeof separator === 'string' ? separator : '\t' };
}

const TRANSFORMS: Transform[] = [
    {
        label: '$(list-unordered) Unwrap IN (...) into a list',
        description: "IN ('a','b') → a, b on separate lines",
        detail: "Undoes quoting, so 'O''Brien' becomes O'Brien. Accepts a whole WHERE predicate.",
        async run(text, eol) {
            return unwrapInClause(text).join(eol);
        }
    },
    {
        label: '$(symbol-field) Extract a column',
        description: 'Keep one column of tabular data',
        detail: 'Useful for turning one column of a pasted table into an IN list.',
        async run(text, eol) {
            const { table } = readTable(text);

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

            const header = await vscode.window.showQuickPick(
                ['Yes — leave it out', 'No — the first row is data'],
                { placeHolder: 'Is the first row a header?' }
            );
            if (!header) {
                return undefined;
            }

            return extractColumn(table, column.index, header.startsWith('Yes')).join(eol);
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
        if (!transform) {
            return;
        }

        try {
            const result = await transform.run(text, eol);
            if (result === undefined) {
                return;
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
