/**
 * JSON reading and writing for the table conversions.
 *
 * `JSON.parse` is not used: it turns every number into a double, so an 18-digit
 * id such as 1234567890123456789 silently becomes 1234567890123456800. For a
 * tool whose output feeds `IN (...)` lists and INSERTs, that is a wrong-data
 * bug. The parser here keeps each number as its source text instead.
 */

import { isPlainNumber } from './sqlUtils';

/** A JSON number kept exactly as written, so no digits are lost. */
export class JsonNumber {
    constructor(readonly raw: string) {}

    toString(): string {
        return this.raw;
    }
}

export type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | JsonObject;
export interface JsonObject {
    [key: string]: JsonValue;
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof JsonNumber);
}

const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * Assign a property without `__proto__` being treated as the prototype setter,
 * which would drop the field and alter the object.
 */
function setProperty(object: JsonObject, key: string, value: JsonValue): void {
    if (key === '__proto__') {
        Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
    } else {
        object[key] = value;
    }
}

const NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES: Record<string, string> = {
    '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t'
};

/**
 * Parse one JSON value.
 *
 * Strict JSON, with one leniency: a trailing comma before `]` or `}` is
 * accepted, since hand-edited and copied JSON often has one and rejecting it
 * helps nobody. Errors give a line and column.
 *
 * @param firstLine Line number of the text's first line, for error messages
 * when the text is one line of a larger document.
 */
export function parseJson(text: string, firstLine = 1): JsonValue {
    let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;

    const fail = (message: string): never => {
        const before = text.slice(0, pos);
        const line = firstLine + before.split('\n').length - 1;
        const column = pos - before.lastIndexOf('\n');
        throw new Error(`Invalid JSON at line ${line}, column ${column}: ${message}.`);
    };

    const skipWhitespace = () => {
        while (pos < text.length && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\n' || text[pos] === '\r')) {
            pos++;
        }
    };

    const expect = (char: string, what: string) => {
        skipWhitespace();
        if (text[pos] !== char) {
            fail(pos >= text.length ? `unexpected end of input, expected ${what}` : `expected ${what}`);
        }
        pos++;
    };

    const parseString = (): string => {
        pos++; // opening quote
        let result = '';
        let start = pos;
        while (pos < text.length) {
            const char = text[pos];
            if (char === '"') {
                result += text.slice(start, pos);
                pos++;
                return result;
            }
            if (char === '\\') {
                result += text.slice(start, pos);
                const escape = text[pos + 1];
                if (escape === 'u') {
                    const hex = text.slice(pos + 2, pos + 6);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                        fail('invalid \\u escape');
                    }
                    result += String.fromCharCode(parseInt(hex, 16));
                    pos += 6;
                } else if (escape !== undefined && hasOwn(ESCAPES, escape)) {
                    result += ESCAPES[escape];
                    pos += 2;
                } else {
                    fail('invalid escape in string');
                }
                start = pos;
            } else {
                pos++;
            }
        }
        return fail('unterminated string');
    };

    const parseNumber = (): JsonNumber => {
        NUMBER_PATTERN.lastIndex = pos;
        const match = NUMBER_PATTERN.exec(text);
        if (!match) {
            return fail('invalid number');
        }
        pos += match[0].length;
        return new JsonNumber(match[0]);
    };

    const parseArray = (): JsonValue[] => {
        pos++; // [
        const items: JsonValue[] = [];
        skipWhitespace();
        if (text[pos] === ']') {
            pos++;
            return items;
        }
        for (;;) {
            items.push(parseValue());
            skipWhitespace();
            if (text[pos] === ',') {
                pos++;
                skipWhitespace();
                if (text[pos] === ']') { pos++; return items; } // trailing comma
            } else if (text[pos] === ']') {
                pos++;
                return items;
            } else {
                fail(pos >= text.length ? 'unexpected end of input, expected , or ]' : 'expected , or ]');
            }
        }
    };

    const parseObject = (): JsonObject => {
        pos++; // {
        const object: JsonObject = {};
        skipWhitespace();
        if (text[pos] === '}') {
            pos++;
            return object;
        }
        for (;;) {
            skipWhitespace();
            if (text[pos] !== '"') {
                fail(pos >= text.length ? 'unexpected end of input' : 'expected a property name in double quotes');
            }
            const key = parseString();
            expect(':', ':');
            setProperty(object, key, parseValue());
            skipWhitespace();
            if (text[pos] === ',') {
                pos++;
                skipWhitespace();
                if (text[pos] === '}') { pos++; return object; } // trailing comma
            } else if (text[pos] === '}') {
                pos++;
                return object;
            } else {
                fail(pos >= text.length ? 'unexpected end of input, expected , or }' : 'expected , or }');
            }
        }
    };

    const parseValue = (): JsonValue => {
        skipWhitespace();
        const char = text[pos];
        if (char === '{') { return parseObject(); }
        if (char === '[') { return parseArray(); }
        if (char === '"') { return parseString(); }
        if (char === '-' || (char >= '0' && char <= '9')) { return parseNumber(); }
        if (text.startsWith('true', pos)) { pos += 4; return true; }
        if (text.startsWith('false', pos)) { pos += 5; return false; }
        if (text.startsWith('null', pos)) { pos += 4; return null; }
        return fail(pos >= text.length ? 'unexpected end of input' : `unexpected character '${char}'`);
    };

    const value = parseValue();
    skipWhitespace();
    if (pos < text.length) {
        fail('unexpected text after the JSON value');
    }
    return value;
}

/**
 * Serialise a value, writing numbers exactly as they were read.
 *
 * @param indent Indentation per level; empty for compact single-line output.
 */
export function stringifyJson(value: JsonValue, indent = ''): string {
    const write = (current: JsonValue, depth: string): string => {
        if (current === null) { return 'null'; }
        if (typeof current === 'boolean') { return String(current); }
        if (typeof current === 'string') { return JSON.stringify(current); }
        if (current instanceof JsonNumber) { return current.raw; }

        const inner = depth + indent;
        const open = indent ? '\n' + inner : '';
        const close = indent ? '\n' + depth : '';
        const separator = indent ? ',\n' + inner : ',';

        if (Array.isArray(current)) {
            return current.length === 0
                ? '[]'
                : '[' + open + current.map(item => write(item, inner)).join(separator) + close + ']';
        }

        const colon = indent ? ': ' : ':';
        const entries = Object.entries(current);
        return entries.length === 0
            ? '{}'
            : '{' + open + entries.map(([key, item]) => JSON.stringify(key) + colon + write(item, inner)).join(separator) + close + '}';
    };
    return write(value, '');
}

/**
 * Whether text is meant as JSON, judged from how it starts.
 *
 * `{` is always JSON. `[` is JSON only when followed by something a JSON array
 * can contain — otherwise `[id]	[name]`, a header of SQL Server bracketed
 * names, would be misread.
 */
export function looksLikeJson(text: string): boolean {
    const start = text.replace(/^﻿/, '').trimStart();
    return start.startsWith('{') || /^\[\s*(?:[{["\]\d-]|(?:true|false|null)\b)/.test(start);
}

/**
 * Parse a JSON document, or NDJSON — one value per line — as an array of
 * those values.
 *
 * NDJSON is recognised by a complete value on the first line with more lines
 * after it; a pretty-printed document never has that shape. Errors in NDJSON
 * name the line they are on.
 */
export function parseJsonDocument(text: string): JsonValue {
    try {
        return parseJson(text);
    } catch (error) {
        const lines = text.split('\n')
            .map((line, index) => ({ text: line, number: index + 1 }))
            .filter(line => line.text.trim() !== '');
        if (lines.length > 1 && isCompleteJson(lines[0].text)) {
            return lines.map(line => parseJson(line.text, line.number));
        }
        throw error;
    }
}

export interface JsonRecords {
    records: JsonValue[];
    /** Where the records were found: `$` for the top level, `$.data` when unwrapped. */
    path: string;
}

/**
 * Read JSON as a list of records.
 *
 * Accepts a JSON array, a single object, or NDJSON (one value per line). An
 * object whose only array-of-objects property holds the rows — the
 * `{"data": [...], "meta": {...}}` shape of most API responses — is unwrapped,
 * and `path` says so.
 */
export function parseJsonRecords(text: string): JsonRecords {
    const root = parseJsonDocument(text);

    if (Array.isArray(root)) {
        return { records: root, path: '$' };
    }
    if (isJsonObject(root)) {
        const tables = Object.keys(root).filter(key => {
            const value = root as JsonObject;
            const candidate = value[key];
            return Array.isArray(candidate) && candidate.length > 0 && candidate.every(isJsonObject);
        });
        if (tables.length === 1) {
            return { records: (root[tables[0]] as JsonValue[]), path: '$' + formatPathKey(tables[0]) };
        }
    }
    return { records: [root], path: '$' };
}

function isCompleteJson(text: string): boolean {
    try {
        parseJson(text);
        return true;
    } catch {
        return false;
    }
}

function formatPathKey(key: string): string {
    return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/** A value as it appears in one table cell. */
function cellText(value: JsonValue): string {
    if (value === null) { return ''; }
    if (typeof value === 'string') { return value; }
    if (typeof value === 'boolean' || value instanceof JsonNumber) { return String(value); }
    return stringifyJson(value);
}

/**
 * Turn records into rows, header first.
 *
 * Columns are the union of keys across all records, in first-seen order, so a
 * field missing from the first record still gets a column. Nested objects are
 * flattened to dotted names (`address.city`); arrays become a JSON cell, since
 * there is no lossless way to spread them across a fixed set of columns.
 * Records that are not objects go in a single `value` column.
 */
export function recordsToTable(records: JsonValue[]): string[][] {
    if (records.length === 0) {
        throw new Error('The JSON array is empty.');
    }

    const headers: string[] = [];
    const seen = new Set<string>();
    const flattened = records.map(record => {
        const fields = new Map<string, string>();
        if (isJsonObject(record)) {
            flattenInto(record, '', fields);
        } else {
            fields.set('value', cellText(record));
        }
        for (const key of fields.keys()) {
            if (!seen.has(key)) {
                seen.add(key);
                headers.push(key);
            }
        }
        return fields;
    });

    if (headers.length === 0) {
        throw new Error('The JSON records have no fields to make columns from.');
    }
    return [headers, ...flattened.map(fields => headers.map(header => fields.get(header) ?? ''))];
}

function flattenInto(object: JsonObject, prefix: string, out: Map<string, string>): void {
    for (const [key, value] of Object.entries(object)) {
        const name = prefix ? `${prefix}.${key}` : key;
        if (isJsonObject(value) && Object.keys(value).length > 0) {
            flattenInto(value, name, out);
        } else {
            out.set(name, cellText(value));
        }
    }
}

/**
 * Make header cells into usable, distinct JSON keys: blanks are named by
 * position and repeats suffixed, so no column overwrites another.
 */
export function uniqueKeys(headers: string[]): string[] {
    const used = new Set<string>();
    return headers.map((header, index) => {
        const base = header.trim() || `column_${index + 1}`;
        let key = base;
        for (let n = 2; used.has(key); n++) {
            key = `${base}_${n}`;
        }
        used.add(key);
        return key;
    });
}

/**
 * A cell as a typed JSON value: empty becomes null, plain numbers become
 * numbers, and true/false become booleans. Zero-padded ids such as `007` are
 * not plain numbers and stay strings.
 */
function typedValue(cell: string): JsonValue {
    const trimmed = cell.trim();
    if (trimmed === '') { return null; }
    if (isPlainNumber(trimmed)) { return new JsonNumber(trimmed); }
    if (/^true$/i.test(trimmed)) { return true; }
    if (/^false$/i.test(trimmed)) { return false; }
    return cell;
}

/**
 * Turn rows into records, using the first row as keys.
 *
 * @param inferTypes Write numbers, booleans and null as JSON types. When off,
 * every value is a string exactly as it appeared.
 */
export function tableToRecords(table: string[][], inferTypes: boolean): JsonObject[] {
    if (table.length === 0) {
        throw new Error('The selection has no rows.');
    }
    const keys = uniqueKeys(table[0]);
    return table.slice(1).map(row => {
        const record: JsonObject = {};
        keys.forEach((key, i) => {
            const cell = i < row.length ? row[i] : '';
            setProperty(record, key, inferTypes ? typedValue(cell) : cell);
        });
        return record;
    });
}

export type JsonOutputFormat = 'array' | 'ndjson';

/** Rows to a pretty-printed JSON array, or to NDJSON with one record per line. */
export function tableToJson(table: string[][], format: JsonOutputFormat, inferTypes: boolean): string {
    const records = tableToRecords(table, inferTypes);
    return format === 'ndjson'
        ? records.map(record => stringifyJson(record)).join('\n')
        : stringifyJson(records, '  ');
}

type PathStep = { key: string } | { index: number } | { wildcard: true };

const BRACKET_STEP = /\[\s*(?:(\*)|(\d+)|'([^']*)'|"([^"]*)")\s*\]/y;
const NAME_STEP = /[^.[\]]+/y;

function parsePath(path: string): PathStep[] {
    let rest = path.trim();
    if (rest.startsWith('$')) {
        rest = rest.slice(1);
    }
    // A bare leading name — `items[*].id` — reads as `.items[*].id`.
    if (rest !== '' && rest[0] !== '.' && rest[0] !== '[') {
        rest = '.' + rest;
    }

    const steps: PathStep[] = [];
    let i = 0;
    while (i < rest.length) {
        if (rest[i] === '.') {
            i++;
            if (rest[i] === '*') {
                steps.push({ wildcard: true });
                i++;
                continue;
            }
            NAME_STEP.lastIndex = i;
            const name = NAME_STEP.exec(rest);
            if (!name) {
                throw new Error(`Invalid path "${path}": expected a name after "." at position ${i}.`);
            }
            steps.push({ key: name[0].trim() });
            i += name[0].length;
        } else if (rest[i] === '[') {
            BRACKET_STEP.lastIndex = i;
            const match = BRACKET_STEP.exec(rest);
            if (!match) {
                throw new Error(`Invalid path "${path}": use [*], [0], or ['name'] in brackets.`);
            }
            if (match[1]) {
                steps.push({ wildcard: true });
            } else if (match[2] !== undefined) {
                steps.push({ index: Number(match[2]) });
            } else {
                steps.push({ key: match[3] ?? match[4] });
            }
            i += match[0].length;
        } else {
            throw new Error(`Invalid path "${path}" at position ${i}.`);
        }
    }
    return steps;
}

export interface ExtractedValues {
    values: string[];
    /** Places where the path found nothing, or found null. */
    missing: number;
}

/**
 * Collect the values a path points at, as text, ready to become a list.
 *
 * Supports `$`, `.name`, `['name']`, `[0]`, `[*]` and `.*`. Two leniencies make
 * the common case short: a name applied to an array applies to each element,
 * so `id` on an array of records lists every id; and a path that ends on an
 * array lists its elements. Objects and arrays found along the way come out as
 * compact JSON.
 */
export function extractJsonPath(root: JsonValue, path: string): ExtractedValues {
    const steps = parsePath(path);
    let missing = 0;

    const lookUp = (node: JsonValue, key: string, out: JsonValue[]) => {
        if (Array.isArray(node)) {
            node.forEach(item => lookUp(item, key, out));
        } else if (isJsonObject(node) && hasOwn(node, key)) {
            out.push(node[key]);
        } else {
            missing++;
        }
    };

    let nodes: JsonValue[] = [root];
    for (const step of steps) {
        const next: JsonValue[] = [];
        for (const node of nodes) {
            if ('key' in step) {
                lookUp(node, step.key, next);
            } else if ('index' in step) {
                if (Array.isArray(node) && step.index < node.length) {
                    next.push(node[step.index]);
                } else {
                    missing++;
                }
            } else if (Array.isArray(node)) {
                next.push(...node);
            } else if (isJsonObject(node)) {
                next.push(...Object.values(node));
            } else {
                missing++;
            }
        }
        nodes = next;
    }

    const values: string[] = [];
    for (const node of nodes.flatMap(node => (Array.isArray(node) ? node : [node]))) {
        if (node === null) {
            missing++;
        } else {
            values.push(cellText(node));
        }
    }
    return { values, missing };
}
