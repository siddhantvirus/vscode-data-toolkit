/**
 * Line-by-line list transforms behind "Transform Selection…".
 *
 * Pure functions over arrays of lines, unit-tested directly; the command only
 * gathers choices and writes the result back.
 */

/** Split text into lines, without the empty line a trailing newline leaves. */
export function toLines(text: string): string[] {
    const lines = text.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

export type SortMode = 'natural' | 'naturalDesc' | 'numeric' | 'numericDesc' | 'length' | 'reverse';

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** A number as people write it in a list: `1,234.5`, `-7`, `.5`. Null otherwise. */
function parseLooseNumber(value: string): number | null {
    const cleaned = value.trim().replace(/,/g, '');
    if (cleaned === '' || !/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(cleaned)) {
        return null;
    }
    return Number(cleaned);
}

/**
 * Sort lines. Blank lines are dropped — they would otherwise all sort to one
 * end and are rarely wanted in a sorted list.
 *
 * - `natural` sorts text the way people expect: `item2` before `item10`, and
 *   case-insensitively.
 * - `numeric` sorts by value; lines that are not numbers follow, in natural
 *   order, so nothing is lost.
 * - `reverse` reverses the current order without sorting.
 */
export function sortLines(lines: string[], mode: SortMode): string[] {
    const items = lines.filter(line => line.trim() !== '');

    switch (mode) {
        case 'natural':
            return items.sort(naturalCollator.compare);
        case 'naturalDesc':
            return items.sort((a, b) => naturalCollator.compare(b, a));
        case 'length':
            return items.sort((a, b) => a.length - b.length || naturalCollator.compare(a, b));
        case 'reverse':
            return items.reverse();
        case 'numeric':
        case 'numericDesc': {
            const direction = mode === 'numeric' ? 1 : -1;
            const numbers = items
                .map(line => ({ line, value: parseLooseNumber(line) }))
                .filter((item): item is { line: string; value: number } => item.value !== null)
                .sort((a, b) => (a.value - b.value) * direction)
                .map(item => item.line);
            const others = items.filter(line => parseLooseNumber(line) === null).sort(naturalCollator.compare);
            return [...numbers, ...others];
        }
    }
}

export type CaseMode = 'upper' | 'lower' | 'title' | 'snake' | 'camel' | 'pascal' | 'kebab' | 'constant';

/**
 * Split an identifier or phrase into lowercase words: `totalSales`,
 * `Total Sales (USD)`, `total-sales` and `TOTAL_SALES` all give the same words.
 */
export function splitWords(value: string): string[] {
    return value
        .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')       // camelCase → camel Case
        .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')        // HTTPServer → HTTP Server
        .split(/[^\p{L}\p{N}]+/u)
        .filter(word => word !== '')
        .map(word => word.toLowerCase());
}

const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Change the case of one line. The identifier styles (snake, camel, …) rebuild
 * the line from its words, so punctuation is dropped — that is the point when
 * turning a spreadsheet header into a column name.
 */
export function changeCase(line: string, mode: CaseMode): string {
    switch (mode) {
        case 'upper': return line.toUpperCase();
        case 'lower': return line.toLowerCase();
        case 'title':
            return line.toLowerCase().replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_, before, letter) => before + letter.toUpperCase());
    }

    const words = splitWords(line);
    switch (mode) {
        case 'snake': return words.join('_');
        case 'kebab': return words.join('-');
        case 'constant': return words.join('_').toUpperCase();
        case 'pascal': return words.map(capitalise).join('');
        case 'camel': return words.map((word, i) => (i === 0 ? word : capitalise(word))).join('');
    }
}

export interface WhitespaceOptions {
    /** Remove leading and trailing whitespace from each line. */
    trim: boolean;
    /** Replace runs of spaces and tabs inside a line with one space. */
    collapse: boolean;
    /** Remove lines that are empty after the above. */
    dropBlank: boolean;
}

export function normaliseWhitespace(lines: string[], options: WhitespaceOptions): string[] {
    let result = lines.map(line => {
        let value = line;
        if (options.collapse) {
            value = value.replace(/[ \t ]+/g, ' ');
        }
        if (options.trim) {
            value = value.trim();
        }
        return value;
    });
    if (options.dropBlank) {
        result = result.filter(line => line.trim() !== '');
    }
    return result;
}

/**
 * Put each line into a template, where `{}` stands for the line: `'{}',`
 * quotes and comma-terminates every value. Blank lines are left blank.
 */
export function applyTemplate(lines: string[], template: string): string[] {
    if (!template.includes('{}')) {
        throw new Error('The template needs {} where each line goes, e.g. \'{}\',');
    }
    return lines.map(line => (line.trim() === '' ? line : template.split('{}').join(line)));
}

/**
 * Read a regular expression typed by the user: `/pattern/flags`, or a bare
 * pattern. Throws with the engine's own message when it is invalid.
 */
export function parseUserRegExp(input: string, extraFlags = ''): RegExp {
    const literal = /^\/(.*)\/([dgimsuy]*)$/s.exec(input);
    const source = literal ? literal[1] : input;
    const flags = new Set([...(literal ? literal[2] : ''), ...extraFlags]);
    try {
        return new RegExp(source, [...flags].join(''));
    } catch (error) {
        throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** Keep the lines that match, or drop them. */
export function filterLines(lines: string[], pattern: RegExp, keep: boolean): string[] {
    // A global regex is stateful across test() calls; use a fresh one.
    const regex = new RegExp(pattern.source, pattern.flags.replace('g', '').replace('y', ''));
    return lines.filter(line => regex.test(line) === keep);
}

/**
 * Every match of a pattern, one per entry. With capture groups, the groups are
 * returned instead of the whole match — tab-separated when there are several,
 * so the result pastes into a spreadsheet as columns.
 */
export function extractMatches(text: string, pattern: RegExp): string[] {
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    const results: string[] = [];
    for (const match of text.matchAll(regex)) {
        if (match[0] === '') {
            continue;
        }
        results.push(match.length > 1 ? match.slice(1).map(group => group ?? '').join('\t') : match[0]);
    }
    return results;
}

/**
 * Remove rows whose key column repeats, keeping the first or the last
 * occurrence. Row order is otherwise kept. Distinct from removing duplicate
 * lines: two rows with the same key but different values are still duplicates
 * here.
 */
export function dedupeByColumn(table: string[][], index: number, keep: 'first' | 'last', hasHeader: boolean): string[][] {
    const header = hasHeader ? table.slice(0, 1) : [];
    const rows = hasHeader ? table.slice(1) : table;
    const key = (row: string[]) => (index < row.length ? row[index].trim() : '');

    const chosen = new Map<string, number>();
    rows.forEach((row, i) => {
        if (keep === 'last' || !chosen.has(key(row))) {
            chosen.set(key(row), i);
        }
    });
    const kept = new Set(chosen.values());
    return [...header, ...rows.filter((_, i) => kept.has(i))];
}
