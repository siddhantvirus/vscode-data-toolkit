import * as assert from 'assert';
import * as vscode from 'vscode';

import {
	applyNullValues,
	batchRows,
	describeRaggedRows,
	detectSeparator,
	findRaggedRows,
	formatSqlValue,
	getDefaultDataType,
	inferSqlDataType,
	isPlainNumber,
	joinAsDelimitedLine,
	needsQuoting,
	parseDelimitedLine,
	parseDelimitedText,
	quoteIdentifier,
	sanitizeColumnNames,
	TIMESTAMP_PATTERN
} from '../utils/sqlUtils';
import { escapeHtml, escapeRegExp, getNonce } from '../utils/htmlUtils';
import { diffRows, suggestKeyColumn } from '../utils/diffUtils';
import {
	buildChunkedInClause,
	extractColumn,
	formatDelimitedRow,
	isMarkdownTable,
	parseMarkdownTable,
	parseStructuredTable,
	splitIntoValues,
	tableToMarkdown,
	transposeTable,
	unwrapInClause
} from '../utils/transformUtils';
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
} from '../utils/listUtils';
import {
	extractJsonPath,
	JsonNumber,
	JsonValue,
	looksLikeJson,
	parseJson,
	parseJsonDocument,
	parseJsonRecords,
	recordsToTable,
	stringifyJson,
	tableToJson,
	tableToRecords,
	uniqueKeys
} from '../utils/jsonUtils';
import {
	convertToCommaLine,
	createSqlTableStatement,
	formatCSVCell,
	parseSqlTabularData
} from '../extension';

suite('sqlUtils — isPlainNumber', () => {
	test('accepts plain integers and decimals', () => {
		assert.strictEqual(isPlainNumber('0'), true);
		assert.strictEqual(isPlainNumber('42'), true);
		assert.strictEqual(isPlainNumber('-17'), true);
		assert.strictEqual(isPlainNumber('3.14'), true);
	});

	test('rejects values Number() would silently accept', () => {
		// Zero-padded ids must stay strings or they lose their padding.
		assert.strictEqual(isPlainNumber('00123'), false);
		assert.strictEqual(isPlainNumber('0x1F'), false);
		assert.strictEqual(isPlainNumber('1e5'), false);
		assert.strictEqual(isPlainNumber('Infinity'), false);
		assert.strictEqual(isPlainNumber(''), false);
		assert.strictEqual(isPlainNumber('abc'), false);
	});
});

suite('sqlUtils — formatSqlValue', () => {
	test('blank values become NULL', () => {
		assert.strictEqual(formatSqlValue('', true), 'NULL');
		assert.strictEqual(formatSqlValue('   ', true), 'NULL');
	});

	test('numbers are unquoted only when inferring types', () => {
		assert.strictEqual(formatSqlValue('42', true), '42');
		assert.strictEqual(formatSqlValue('42', false), "'42'");
	});

	test('zero-padded values keep their padding', () => {
		assert.strictEqual(formatSqlValue('007', true), "'007'");
	});

	test('single quotes are doubled', () => {
		assert.strictEqual(formatSqlValue("O'Brien", true), "'O''Brien'");
	});

	test('dates are emitted as quoted literals', () => {
		assert.strictEqual(formatSqlValue('2024-03-15', true), "'2024-03-15'");
		assert.strictEqual(formatSqlValue('2024-03-15 09:30', true), "'2024-03-15 09:30'");
	});
});

suite('sqlUtils — inferSqlDataType', () => {
	const rows = (...values: string[]) => values.map(v => [v]);

	test('detects integers, decimals, dates and timestamps', () => {
		assert.strictEqual(inferSqlDataType(rows('1', '2', '3'), 0, 'postgres'), 'INTEGER');
		assert.strictEqual(inferSqlDataType(rows('1.5', '2.25'), 0, 'postgres'), 'DECIMAL');
		assert.strictEqual(inferSqlDataType(rows('2024-03-15'), 0, 'postgres'), 'DATE');
		assert.strictEqual(inferSqlDataType(rows('2024-03-15 09:30'), 0, 'postgres'), 'TIMESTAMP');
	});

	test('zero-padded values are text, not integers', () => {
		assert.strictEqual(inferSqlDataType(rows('007', '013'), 0, 'postgres'), 'VARCHAR(255)');
	});

	test('defaults to a fixed VARCHAR(255) so DDL cannot be too narrow', () => {
		assert.strictEqual(inferSqlDataType(rows('ab'), 0, 'postgres'), 'VARCHAR(255)');
		assert.strictEqual(inferSqlDataType(rows('ab'), 0, 'postgres', 'fixed'), 'VARCHAR(255)');
	});

	test('opting in sizes VARCHAR from the widest value', () => {
		assert.strictEqual(inferSqlDataType(rows('007', '013'), 0, 'postgres', 'fromSample'), 'VARCHAR(10)');
		assert.strictEqual(inferSqlDataType(rows('a'.repeat(100)), 0, 'mysql', 'fromSample'), 'VARCHAR(150)');
	});

	test('a non-numeric value late in the column still widens the VARCHAR', () => {
		// Regression: an early loop exit used to leave maxLength short.
		const type = inferSqlDataType(rows('1', '2', 'x'.repeat(80)), 0, 'postgres', 'fromSample');
		assert.strictEqual(type, 'VARCHAR(120)');
	});

	test('falls back to the dialect default for empty columns', () => {
		assert.strictEqual(inferSqlDataType([], 0, 'spark'), getDefaultDataType('spark'));
		assert.strictEqual(getDefaultDataType('spark'), 'STRING');
	});
});

suite('sqlUtils — detectSeparator', () => {
	test('prefers tabs, then commas, then pipes', () => {
		assert.strictEqual(detectSeparator('a\tb,c'), '\t');
		assert.strictEqual(detectSeparator('a,b|c'), ',');
		assert.strictEqual(detectSeparator('a|b'), '|');
	});

	test('space-aligned columns split on runs of spaces, not single spaces', () => {
		const sep = detectSeparator('id    full name    city');
		assert.ok(sep instanceof RegExp, 'expected a RegExp for space-aligned data');
		// A single-space separator would break "full name" into two columns.
		assert.deepStrictEqual('id    full name    city'.split(sep!), ['id', 'full name', 'city']);
	});

	test('returns null when there is no separator', () => {
		assert.strictEqual(detectSeparator('single'), null);
		assert.strictEqual(detectSeparator(''), null);
	});
});

suite('sqlUtils — parseDelimitedLine', () => {
	test('a quoted field containing the delimiter stays one column', () => {
		assert.deepStrictEqual(
			parseDelimitedLine('1,"Smith, John",NYC', ','),
			['1', 'Smith, John', 'NYC']
		);
	});

	test('doubled quotes inside a quoted field are unescaped', () => {
		assert.deepStrictEqual(
			parseDelimitedLine('1,"He said ""hi""",x', ','),
			['1', 'He said "hi"', 'x']
		);
	});

	test('unquoted lines are unaffected', () => {
		assert.deepStrictEqual(parseDelimitedLine('a,b,c', ','), ['a', 'b', 'c']);
		assert.deepStrictEqual(parseDelimitedLine('a\tb', '\t'), ['a', 'b']);
	});

	test('an unterminated quote degrades gracefully', () => {
		assert.deepStrictEqual(parseDelimitedLine('1,"oops', ','), ['1', 'oops']);
	});

	test('a RegExp separator falls back to a plain split', () => {
		assert.deepStrictEqual(
			parseDelimitedLine('id    full name    city', /\s{2,}/),
			['id', 'full name', 'city']
		);
	});
});

suite('sqlUtils — parseDelimitedText', () => {
	test('a quoted field containing a newline stays one field', () => {
		assert.deepStrictEqual(
			parseDelimitedText('id,notes\n1,"line one\nline two"\n2,plain', ','),
			[['id', 'notes'], ['1', 'line one\nline two'], ['2', 'plain']]
		);
	});

	test('CRLF inside quotes is preserved', () => {
		assert.deepStrictEqual(
			parseDelimitedText('a,b\r\n1,"x\r\ny"\r\n', ','),
			[['a', 'b'], ['1', 'x\r\ny']]
		);
	});

	test('escaped quotes survive across lines', () => {
		assert.deepStrictEqual(
			parseDelimitedText('1,"he said ""hi""\nbye"', ','),
			[['1', 'he said "hi"\nbye']]
		);
	});

	test('ordinary documents are unaffected', () => {
		assert.deepStrictEqual(
			parseDelimitedText('a,b\n1,2\n3,4', ','),
			[['a', 'b'], ['1', '2'], ['3', '4']]
		);
	});

	test('trailing newlines and blank lines do not create rows', () => {
		assert.deepStrictEqual(parseDelimitedText('a,b\n1,2\n', ','), [['a', 'b'], ['1', '2']]);
		assert.deepStrictEqual(parseDelimitedText('a,b\n\n1,2', ','), [['a', 'b'], ['1', '2']]);
	});

	test('a RegExp separator falls back to line-at-a-time parsing', () => {
		assert.deepStrictEqual(
			parseDelimitedText('id    full name\n1     Alice Smith', /\s{2,}/),
			[['id', 'full name'], ['1', 'Alice Smith']]
		);
	});

	test('an unterminated quote degrades gracefully', () => {
		assert.deepStrictEqual(parseDelimitedText('1,"oops\n2,x', ','), [['1', 'oops\n2,x']]);
	});
});

suite('sqlUtils — ragged rows', () => {
	test('a uniform table has no ragged rows', () => {
		const { expected, ragged } = findRaggedRows([['a', 'b'], ['1', '2'], ['3', '4']]);
		assert.strictEqual(expected, 2);
		assert.deepStrictEqual(ragged, []);
	});

	test('short and long rows are both reported, with their position and width', () => {
		const { ragged } = findRaggedRows([['a', 'b', 'c'], ['1', '2'], ['1', '2', '3', '4']]);
		assert.deepStrictEqual(ragged, [{ row: 2, fields: 2 }, { row: 3, fields: 4 }]);
	});

	test('the description names the rows and says data is dropped', () => {
		const text = describeRaggedRows([{ row: 3, fields: 4 }], 3);
		assert.ok(text.includes('row 3 has 4'), text);
		assert.ok(/dropped/.test(text), text);
	});

	test('long lists are abbreviated rather than listing every row', () => {
		const ragged = Array.from({ length: 8 }, (_, i) => ({ row: i + 2, fields: 1 }));
		const text = describeRaggedRows(ragged, 2);
		assert.ok(text.includes('and 3 more'), text);
	});
});

suite('sqlUtils — sanitizeColumnNames', () => {
	test('punctuation collapses without doubled or trailing underscores', () => {
		assert.deepStrictEqual(sanitizeColumnNames(['Total Sales (USD)']), ['Total_Sales_USD']);
	});

	test('identifiers cannot start with a digit', () => {
		assert.deepStrictEqual(sanitizeColumnNames(['2024 Revenue']), ['col_2024_Revenue']);
	});

	test('duplicates are made unique, case-insensitively', () => {
		assert.deepStrictEqual(
			sanitizeColumnNames(['Region', 'Region', 'region']),
			['Region', 'Region_2', 'region_3']
		);
	});

	test('blank headers get positional names', () => {
		assert.deepStrictEqual(sanitizeColumnNames(['id', '', '  ']), ['id', 'column2', 'column3']);
	});
});

suite('sqlUtils — identifier quoting', () => {
	test('everyday column names are left bare', () => {
		// Quoting these is the noise this behaviour exists to remove.
		for (const name of ['id', 'name', 'type', 'value', 'status', 'count', 'date', 'timestamp', 'my_table']) {
			assert.strictEqual(needsQuoting(name), false, `${name} should not need quoting`);
		}
	});

	test('words that would genuinely break are quoted', () => {
		for (const name of ['order', 'group', 'select', 'table', 'key', 'user', 'index']) {
			assert.strictEqual(needsQuoting(name), true, `${name} should need quoting`);
		}
	});

	test('reserved words match regardless of case', () => {
		assert.strictEqual(needsQuoting('ORDER'), true);
	});

	test('names that are not plain identifiers are quoted', () => {
		for (const name of ['my table', '2024_rev', 'a-b', 'tbl.name', '']) {
			assert.strictEqual(needsQuoting(name), true, `${JSON.stringify(name)} should need quoting`);
		}
	});

	test('auto leaves a plain name bare in every dialect', () => {
		for (const dialect of ['spark', 'mysql', 'postgres', 'mssql']) {
			assert.strictEqual(quoteIdentifier('my_table', dialect), 'my_table', dialect);
		}
	});

	test('each dialect uses its own delimiters when quoting is needed', () => {
		assert.strictEqual(quoteIdentifier('order', 'spark'), '`order`');
		assert.strictEqual(quoteIdentifier('order', 'mysql'), '`order`');
		assert.strictEqual(quoteIdentifier('order', 'postgres'), '"order"');
		assert.strictEqual(quoteIdentifier('order', 'mssql'), '[order]');
	});

	test('always mode quotes even plain names', () => {
		assert.strictEqual(quoteIdentifier('my_table', 'spark', 'always'), '`my_table`');
	});

	test('a schema-qualified name keeps its parts separate', () => {
		// Quoting the whole string would create one table literally named
		// "dbo.employees" in the default schema.
		assert.strictEqual(quoteIdentifier('dbo.employees', 'spark'), 'dbo.employees');
		assert.strictEqual(quoteIdentifier('lakehouse.customer', 'spark'), 'lakehouse.customer');
		assert.strictEqual(quoteIdentifier('cat.sch.tbl', 'spark'), 'cat.sch.tbl');
	});

	test('within a qualified name, only the part needing quotes gets them', () => {
		assert.strictEqual(quoteIdentifier('sales.order', 'spark'), 'sales.`order`');
		assert.strictEqual(quoteIdentifier('sales.order', 'postgres'), 'sales."order"');
		assert.strictEqual(quoteIdentifier('sales.order', 'mssql'), 'sales.[order]');
		assert.strictEqual(quoteIdentifier('my schema.tbl', 'spark'), '`my schema`.tbl');
	});

	test('always mode quotes each part of a qualified name', () => {
		assert.strictEqual(quoteIdentifier('dbo.employees', 'spark', 'always'), '`dbo`.`employees`');
	});

	test('a malformed qualifier is treated as a single identifier', () => {
		assert.strictEqual(quoteIdentifier('.foo', 'spark'), '`.foo`');
		assert.strictEqual(quoteIdentifier('a..b', 'spark'), '`a..b`');
	});

	test('delimiters embedded in a name are escaped', () => {
		assert.strictEqual(quoteIdentifier('a`b', 'spark'), '`a``b`');
		assert.strictEqual(quoteIdentifier('a"b', 'postgres'), '"a""b"');
		assert.strictEqual(quoteIdentifier('a]b', 'mssql'), '[a]]b]');
	});
});

suite('sqlUtils — timestamp recognition', () => {
	test('full ISO-8601 with fractional seconds and offsets is recognised', () => {
		for (const value of [
			'2024-03-15 09:30',
			'2024-03-15T09:30:00',
			'2024-03-15T09:30:00.123Z',
			'2024-03-15 09:30:00+05:30',
			'2024-03-15T09:30:00-0800'
		]) {
			assert.ok(TIMESTAMP_PATTERN.test(value), `${value} should be a timestamp`);
		}
	});

	test('non-timestamps are not matched', () => {
		assert.strictEqual(TIMESTAMP_PATTERN.test('not a date'), false);
		assert.strictEqual(TIMESTAMP_PATTERN.test('2024-03-15'), false);
	});
});

suite('diffUtils — diffRows', () => {
	const A = [['id', 'status', 'amount'], ['1', 'active', '100'], ['2', 'closed', '200'], ['3', 'active', '300']];
	const B = [['id', 'status', 'amount'], ['1', 'active', '100'], ['2', 'active', '200'], ['4', 'new', '400']];

	test('classifies added, removed, changed and unchanged', () => {
		assert.deepStrictEqual(diffRows(A, B, 'id').counts, { added: 1, removed: 1, changed: 1, unchanged: 1 });
	});

	test('reports which field changed, not just that the row differs', () => {
		const changed = diffRows(A, B, 'id').rows.find(r => r.status === 'changed');
		assert.strictEqual(changed?.key, '2');
		assert.deepStrictEqual(changed?.changes, [{ column: 'status', before: 'closed', after: 'active' }]);
	});

	test('columns are matched by name, so order does not matter', () => {
		const reordered = [['amount', 'id', 'status'], ['100', '1', 'active'], ['200', '2', 'active'], ['400', '4', 'new']];
		assert.deepStrictEqual(diffRows(A, reordered, 'id').counts, { added: 1, removed: 1, changed: 1, unchanged: 1 });
	});

	test('duplicate keys warn rather than silently resolving', () => {
		const result = diffRows([['id', 'v'], ['1', 'a'], ['1', 'b']], [['id', 'v'], ['1', 'a']], 'id');
		assert.ok(result.warnings.some(w => /duplicate key/i.test(w)), result.warnings.join('; '));
	});

	test('a column on one side only is a warning, not every row changing', () => {
		const withExtra = [['id', 'status', 'amount', 'region'], ['1', 'active', '100', 'EU'], ['2', 'closed', '200', 'US'], ['3', 'active', '300', 'EU']];
		const result = diffRows(A, withExtra, 'id');
		assert.strictEqual(result.counts.changed, 0);
		assert.ok(result.warnings.some(w => /only in B/.test(w)), result.warnings.join('; '));
	});

	test('case and trim options are honoured', () => {
		const x = [['id', 'v'], ['1', 'Active']];
		const y = [['id', 'v'], ['1', ' active ']];
		assert.strictEqual(diffRows(x, y, 'id', { caseSensitive: true, trim: true }).counts.changed, 1);
		assert.strictEqual(diffRows(x, y, 'id', { caseSensitive: false, trim: true }).counts.changed, 0);
	});

	test('a missing key column is reported rather than thrown', () => {
		const result = diffRows(A, B, 'nope');
		assert.strictEqual(result.rows.length, 0);
		assert.ok(result.warnings[0].includes('not present'));
	});
});

suite('diffUtils — suggestKeyColumn', () => {
	test('picks the leftmost column unique on both sides', () => {
		const a = [['id', 'v'], ['1', 'x'], ['2', 'y']];
		assert.strictEqual(suggestKeyColumn(a, a), 'id');
	});

	test('skips a column with repeated values', () => {
		const a = [['a', 'b'], ['1', 'x'], ['1', 'y']];
		assert.strictEqual(suggestKeyColumn(a, a), 'b');
	});

	test('a blank value disqualifies a column', () => {
		const a = [['a', 'b'], ['', 'x'], ['2', 'y']];
		assert.strictEqual(suggestKeyColumn(a, a), 'b');
	});

	test('returns null when nothing qualifies, rather than guessing', () => {
		const a = [['a', 'b'], ['1', 'x'], ['1', 'x']];
		assert.strictEqual(suggestKeyColumn(a, a), null);
	});
});

suite('htmlUtils', () => {
	test('escapeHtml neutralises markup from selected text', () => {
		assert.strictEqual(
			escapeHtml('<img src=x onerror="alert(1)">'),
			'&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
		);
		assert.strictEqual(escapeHtml("it's & more"), 'it&#39;s &amp; more');
	});

	test('escapeRegExp makes metacharacters literal', () => {
		assert.strictEqual('a|b'.replace(new RegExp(escapeRegExp('|'), 'g'), '!'), 'a!b');
		// An unescaped '(' would throw here.
		assert.doesNotThrow(() => new RegExp(escapeRegExp('(')));
	});

	test('getNonce returns a fresh 32-character token', () => {
		const nonce = getNonce();
		assert.match(nonce, /^[A-Za-z0-9]{32}$/);
		assert.notStrictEqual(nonce, getNonce());
	});
});

/**
 * Regression cover for the command path. Every case below corresponds to a bug
 * that was reported by hand and shipped before it was caught, because none of
 * these functions were reachable from a test.
 */
suite('extension — convertToCommaLine', () => {
	const opts = (over: Partial<Parameters<typeof convertToCommaLine>[1]> = {}) => ({
		removeDuplicates: false, separator: ',', enclosure: "'", sqlInClause: false, ...over
	});

	test('a value containing the quote character does not break the clause', () => {
		// Shipped bug: produced 'O'Brien', terminating the literal early.
		assert.strictEqual(convertToCommaLine("O'Brien", opts()), "'O''Brien'");
	});

	test('wraps as an IN clause when asked', () => {
		assert.strictEqual(
			convertToCommaLine('a\nb', opts({ sqlInClause: true })),
			"IN ('a','b')"
		);
	});

	test('trims before deduplicating, so padded values match', () => {
		assert.strictEqual(
			convertToCommaLine('  foo  \nfoo\nbar', opts({ removeDuplicates: true })),
			"'foo','bar'"
		);
	});

	test('CRLF input leaves no carriage return inside the quotes', () => {
		assert.strictEqual(convertToCommaLine('a\r\nb', opts()), "'a','b'");
	});

	test('an empty enclosure emits bare values', () => {
		assert.strictEqual(convertToCommaLine('a\nb', opts({ enclosure: '' })), 'a,b');
	});

	test('rejects input with no usable lines', () => {
		assert.throws(() => convertToCommaLine('   \n\n', opts()));
	});
});

suite('extension — formatCSVCell', () => {
	const opts = (over = {}) => ({
		delimiter: ',', includeHeaders: false, quoteAllFields: false, escapeCharacter: '"', ...over
	});

	test('a regex metacharacter as the quote character does not throw', () => {
		// Shipped bug: escapeCharacter went into a RegExp unescaped, so '(' threw.
		assert.doesNotThrow(() => formatCSVCell('abc', opts({ escapeCharacter: '(' })));
		// One '|' in the value doubles to '||', then the whole cell is wrapped.
		assert.strictEqual(formatCSVCell('a|b', opts({ escapeCharacter: '|' })), '|a||b|');
	});

	test('an empty quote character falls back to a double quote', () => {
		assert.strictEqual(formatCSVCell('a,b', opts({ escapeCharacter: '' })), '"a,b"');
	});

	test('quotes only when the value needs it', () => {
		assert.strictEqual(formatCSVCell('plain', opts()), 'plain');
		assert.strictEqual(formatCSVCell('a,b', opts()), '"a,b"');
		assert.strictEqual(formatCSVCell('a\nb', opts()), '"a\nb"');
	});

	test('embedded quote characters are doubled', () => {
		assert.strictEqual(formatCSVCell('say "hi"', opts()), '"say ""hi"""');
	});
});

suite('extension — parseSqlTabularData', () => {
	test('a quoted field containing the delimiter stays one column', () => {
		const { headers, dataLines } = parseSqlTabularData('id,name\n1,"Smith, John"');
		assert.deepStrictEqual(headers, ['id', 'name']);
		assert.deepStrictEqual(dataLines, [['1', 'Smith, John']]);
	});

	test('a quoted field containing a newline stays one row', () => {
		const { dataLines } = parseSqlTabularData('id,notes\n1,"line one\nline two"');
		assert.deepStrictEqual(dataLines, [['1', 'line one\nline two']]);
	});

	test('space-aligned columns are not split on every space', () => {
		const { headers } = parseSqlTabularData('id    full name    city\n1     Alice Smith  NYC');
		assert.deepStrictEqual(headers, ['id', 'full_name', 'city']);
	});

	test('headers are made valid and unique', () => {
		const { headers } = parseSqlTabularData('Region,Region,2024 Revenue\na,b,c');
		assert.deepStrictEqual(headers, ['Region', 'Region_2', 'col_2024_Revenue']);
	});

	test('ragged rows are reported instead of being squared off silently', () => {
		// Previously padded or truncated with no warning; a long row lost data.
		const { ragged, expectedFields } = parseSqlTabularData('a,b,c\n1,2\n1,2,3,4');
		assert.strictEqual(expectedFields, 3);
		assert.deepStrictEqual(ragged, [{ row: 2, fields: 2 }, { row: 3, fields: 4 }]);
	});

	test('rows are squared off against the header count', () => {
		const { dataLines } = parseSqlTabularData('a,b,c\n1,2');
		assert.deepStrictEqual(dataLines, [['1', '2', '']]);
	});
});

suite('extension — createSqlTableStatement', () => {
	const headers = ['id', 'name'];
	const rows = [['1', 'Alice']];
	const settings = { varcharSizing: 'fixed' as const, quoting: 'auto' as const };
	const opts = (dialect: 'mssql' | 'mysql' | 'postgres' | 'spark') => ({
		tableName: 'my_table', dialect, inferDataTypes: true
	});

	test('every dialect terminates both statements', () => {
		// Shipped bug: only postgres emitted a semicolon, so Spark ended on
		// USING DELTA and the script failed as a multi-statement batch.
		for (const dialect of ['mssql', 'mysql', 'postgres', 'spark'] as const) {
			const sql = createSqlTableStatement(headers, rows, opts(dialect), settings);
			const statements = sql.split('\n').filter(l => l.trim().startsWith('CREATE') || l.trim().startsWith('INSERT'));
			assert.ok(statements.length >= 2, `${dialect}: expected CREATE and INSERT`);
			assert.ok(/\);\s*$/.test(sql.trim()), `${dialect}: script does not end in ');'`);
			assert.strictEqual((sql.match(/;/g) || []).length, 2, `${dialect}: expected two terminators`);
		}
	});

	test('Spark keeps USING DELTA before the terminator', () => {
		const sql = createSqlTableStatement(headers, rows, opts('spark'), settings);
		assert.ok(sql.includes('USING DELTA;'), sql);
	});

	test('a plain table name is not quoted', () => {
		const sql = createSqlTableStatement(headers, rows, opts('spark'), settings);
		assert.ok(sql.includes('CREATE TABLE my_table ('), sql);
	});

	test('a schema-qualified name keeps its parts separate', () => {
		const sql = createSqlTableStatement(
			headers, rows, { ...opts('spark'), tableName: 'lakehouse.customer' }, settings
		);
		assert.ok(sql.includes('CREATE TABLE lakehouse.customer ('), sql);
	});

	test('always mode quotes identifiers', () => {
		const sql = createSqlTableStatement(
			headers, rows, opts('spark'), { ...settings, quoting: 'always' }
		);
		assert.ok(sql.includes('CREATE TABLE `my_table` ('), sql);
	});

	test('zero-padded values are written as text', () => {
		const sql = createSqlTableStatement(headers, [['007', 'Alice']], opts('postgres'), settings);
		assert.ok(sql.includes("('007', 'Alice')"), sql);
	});

	test('values containing a quote are escaped', () => {
		const sql = createSqlTableStatement(headers, [['1', "O'Brien"]], opts('postgres'), settings);
		assert.ok(sql.includes("'O''Brien'"), sql);
	});

	test('multi-row inserts are emitted as one statement', () => {
		const sql = createSqlTableStatement(headers, [['1', 'a'], ['2', 'b']], opts('postgres'), settings);
		assert.strictEqual((sql.match(/INSERT INTO/g) || []).length, 1);
	});
});

suite('sqlUtils — joinAsDelimitedLine', () => {
	test('doubles the enclosure inside a value', () => {
		assert.strictEqual(
			joinAsDelimitedLine(["O'Brien"], { separator: ',', enclosure: "'", sqlInClause: false }),
			"'O''Brien'"
		);
	});

	test('wraps as an IN clause when asked', () => {
		assert.strictEqual(
			joinAsDelimitedLine(['a', 'b'], { separator: ',', enclosure: "'", sqlInClause: true }),
			"IN ('a','b')"
		);
	});

	test('no enclosure leaves values bare', () => {
		assert.strictEqual(
			joinAsDelimitedLine(['a', 'b'], { separator: '|', enclosure: '', sqlInClause: false }),
			'a|b'
		);
	});
});

suite('transformUtils — unwrapInClause', () => {
	test('undoes doubled quotes', () => {
		assert.deepStrictEqual(unwrapInClause("IN ('O''Brien','Alice')"), ["O'Brien", 'Alice']);
	});

	test('accepts a whole WHERE predicate with unquoted numbers', () => {
		assert.deepStrictEqual(unwrapInClause('WHERE id IN (1, 2, 3)'), ['1', '2', '3']);
	});

	test('commas and parentheses inside quotes belong to the value', () => {
		assert.deepStrictEqual(unwrapInClause("IN ('a, b', 'c (d)')"), ['a, b', 'c (d)']);
	});

	test('handles double quotes, the T-SQL N prefix and a trailing comma', () => {
		assert.deepStrictEqual(unwrapInClause('IN ("x", "y")'), ['x', 'y']);
		assert.deepStrictEqual(unwrapInClause("IN (N'abc', N'd')"), ['abc', 'd']);
		assert.deepStrictEqual(unwrapInClause("IN (\n  'a',\n  'b',\n)"), ['a', 'b']);
	});

	test('takes only the first of several IN clauses', () => {
		assert.deepStrictEqual(unwrapInClause("x IN ('a') AND y IN ('b')"), ['a']);
	});

	test('a quoted empty string is kept as a value', () => {
		assert.deepStrictEqual(unwrapInClause("IN ('', 'a')"), ['', 'a']);
	});

	test('is the exact inverse of building the clause', () => {
		const values = ["O'Brien", 'a,b', 'x'];
		const clause = joinAsDelimitedLine(values, { separator: ',', enclosure: "'", sqlInClause: true });
		assert.deepStrictEqual(unwrapInClause(clause), values);
	});

	test('an empty clause is an error, not an empty result', () => {
		assert.throws(() => unwrapInClause('IN ()'));
	});
});

suite('transformUtils — tables', () => {
	const table = [['id', 'name'], ['1', 'Alice'], ['2']];

	test('extractColumn skips the header when asked and pads short rows', () => {
		assert.deepStrictEqual(extractColumn(table, 1, true), ['Alice', '']);
		assert.deepStrictEqual(extractColumn(table, 0, false), ['id', '1', '2']);
	});

	test('extractColumn rejects a column that does not exist', () => {
		assert.throws(() => extractColumn(table, 5, true));
	});

	test('transposeTable pads ragged rows and loses nothing', () => {
		assert.deepStrictEqual(transposeTable(table), [['id', '1', '2'], ['name', 'Alice', '']]);
	});

	test('formatDelimitedRow quotes per RFC 4180 so the output parses back', () => {
		const line = formatDelimitedRow(['a', 'b,c', 'say "hi"'], ',');
		assert.strictEqual(line, 'a,"b,c","say ""hi"""');
		assert.deepStrictEqual(parseDelimitedLine(line, ','), ['a', 'b,c', 'say "hi"']);
	});

	test('splitIntoValues is quote-aware and flattens rows', () => {
		assert.deepStrictEqual(splitIntoValues('a,"b,c",d'), ['a', 'b,c', 'd']);
		assert.deepStrictEqual(splitIntoValues('a\tb\nc\td'), ['a', 'b', 'c', 'd']);
		assert.deepStrictEqual(splitIntoValues('one\n\ntwo'), ['one', 'two']);
	});
});

suite('transformUtils — buildChunkedInClause', () => {
	test('a list within the limit needs no wrapper', () => {
		assert.strictEqual(
			buildChunkedInClause(['a', 'b'], { column: 'id', chunkSize: 1000 }),
			"id IN ('a', 'b')"
		);
	});

	test('longer lists are split into OR-ed chunks and wrapped', () => {
		assert.strictEqual(
			buildChunkedInClause(['1', '2', '3'], { column: 'id', chunkSize: 2 }),
			'(id IN (1, 2)\n OR id IN (3))'
		);
	});

	test('2,500 ids at the Oracle limit become three chunks', () => {
		const ids = Array.from({ length: 2500 }, (_, i) => String(i + 1));
		const sql = buildChunkedInClause(ids, { column: 'id', chunkSize: 1000 });
		assert.strictEqual((sql.match(/ IN \(/g) || []).length, 3);
	});

	test('zero-padded values stay quoted and quotes are escaped', () => {
		assert.ok(buildChunkedInClause(['007', '8'], { column: 'id', chunkSize: 10 }).includes("'007'"));
		assert.ok(buildChunkedInClause(["O'Brien"], { column: 'n', chunkSize: 5 }).includes("'O''Brien'"));
	});

	test('rejects a bad chunk size or missing column', () => {
		assert.throws(() => buildChunkedInClause(['a'], { column: 'id', chunkSize: 0 }));
		assert.throws(() => buildChunkedInClause(['a'], { column: ' ', chunkSize: 10 }));
	});
});

suite('sqlUtils — types for real data', () => {
	const rows = (...values: string[]) => values.map(v => [v]);

	test('ids past INT range are BIGINT, and past BIGINT an exact DECIMAL', () => {
		assert.strictEqual(inferSqlDataType(rows('1', '2147483647'), 0, 'mssql'), 'INT');
		assert.strictEqual(inferSqlDataType(rows('1', '2147483648'), 0, 'mssql'), 'BIGINT');
		assert.strictEqual(inferSqlDataType(rows('1234567890123456789'), 0, 'postgres'), 'BIGINT');
		assert.strictEqual(inferSqlDataType(rows('-9223372036854775808'), 0, 'spark'), 'BIGINT');
		assert.strictEqual(inferSqlDataType(rows('9223372036854775808'), 0, 'spark'), 'DECIMAL(38,0)');
	});

	test('decimals are exact, with the sample’s scale', () => {
		assert.strictEqual(inferSqlDataType(rows('1.5', '20.25'), 0, 'mssql'), 'DECIMAL(38,2)');
		assert.strictEqual(inferSqlDataType(rows('1', '0.125'), 0, 'mysql'), 'DECIMAL(38,3)');
		assert.strictEqual(inferSqlDataType(rows('3.14'), 0, 'spark'), 'DECIMAL(38,2)');
	});

	test('true/false columns are boolean; 0/1 stay numeric', () => {
		assert.strictEqual(inferSqlDataType(rows('true', 'FALSE', ''), 0, 'postgres'), 'BOOLEAN');
		assert.strictEqual(inferSqlDataType(rows('true', 'false'), 0, 'mssql'), 'BIT');
		assert.strictEqual(inferSqlDataType(rows('0', '1'), 0, 'postgres'), 'INTEGER');
		assert.strictEqual(inferSqlDataType(rows('true', 'maybe'), 0, 'postgres'), 'VARCHAR(255)');
	});

	test('boolean values are written as keywords', () => {
		assert.strictEqual(formatSqlValue('True', true, 'BOOLEAN'), 'TRUE');
		assert.strictEqual(formatSqlValue('false', true, 'BIT'), '0');
		assert.strictEqual(formatSqlValue('true', true, 'VARCHAR(255)'), "'true'");
		assert.strictEqual(formatSqlValue('true', false, 'BOOLEAN'), "'true'");
	});

	test('NULL tokens become empty cells', () => {
		assert.deepStrictEqual(
			applyNullValues([['NULL', ' \\N ', 'Null', 'x']], ['NULL', '\\N']),
			[['', '', 'Null', 'x']]
		);
		assert.deepStrictEqual(applyNullValues([['NULL']], []), [['NULL']]);
	});

	test('rows are split into batches', () => {
		assert.deepStrictEqual(batchRows([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
		assert.deepStrictEqual(batchRows([1, 2], 1000), [[1, 2]]);
		assert.deepStrictEqual(batchRows([1, 2], 0), [[1, 2]]);
	});

	test('semicolon-delimited exports are detected', () => {
		assert.strictEqual(detectSeparator('id;amount;city'), ';');
		assert.strictEqual(detectSeparator('id;amount, net;city'), ';');
		assert.strictEqual(detectSeparator('a,b;c'), ',');
	});
});

suite('extension — SQL for real data', () => {
	const settings = { varcharSizing: 'fixed' as const, quoting: 'auto' as const };
	const opts = { tableName: 'flags', dialect: 'mysql' as const, inferDataTypes: true };

	test('NULL tokens, booleans and long ids together', () => {
		const sql = createSqlTableStatement(
			['id', 'active', 'note'],
			[['1234567890123456789', 'true', 'NULL'], ['2', 'false', 'hi']],
			opts,
			settings
		);
		assert.ok(sql.includes('id BIGINT,'), sql);
		assert.ok(sql.includes('active BOOLEAN,'), sql);
		assert.ok(sql.includes('(1234567890123456789, TRUE, NULL)'), sql);
		assert.ok(sql.includes("(2, FALSE, 'hi')"), sql);
	});

	test('inserts are batched and DROP TABLE is optional', () => {
		const rows = Array.from({ length: 2500 }, (_, i) => [String(i)]);
		const sql = createSqlTableStatement(['n'], rows, opts, { ...settings, dropTableIfExists: true });
		assert.ok(sql.startsWith('DROP TABLE IF EXISTS flags;\n\nCREATE TABLE flags ('), sql.slice(0, 80));
		assert.strictEqual((sql.match(/INSERT INTO/g) || []).length, 3);

		const plain = createSqlTableStatement(['n'], rows.slice(0, 3), opts, settings);
		assert.ok(!plain.includes('DROP TABLE'));
		assert.strictEqual((plain.match(/INSERT INTO/g) || []).length, 1);
	});
});

suite('jsonUtils — parseJson', () => {
	test('long integers keep every digit', () => {
		// JSON.parse would give 1234567890123456800.
		const value = parseJson('{"id": 1234567890123456789}');
		assert.strictEqual(stringifyJson(value), '{"id":1234567890123456789}');
	});

	test('numbers keep their written form', () => {
		assert.strictEqual(stringifyJson(parseJson('[1.50, -0, 1e5]')), '[1.50,-0,1e5]');
	});

	test('strings, escapes and literals', () => {
		const value = parseJson('{"a":"x\\"y\\n\\u00e9","b":true,"c":null,"d":false}');
		assert.deepStrictEqual(value, { a: 'x"y\né', b: true, c: null, d: false });
	});

	test('a trailing comma is accepted', () => {
		assert.deepStrictEqual(parseJson('[ "a", "b", ]'), ['a', 'b']);
		assert.deepStrictEqual(parseJson('{"a": "b",}'), { a: 'b' });
	});

	test('errors give the line and column', () => {
		assert.throws(() => parseJson('{\n  "a": 1\n  "b": 2\n}'), /line 3, column 3: expected , or \}/);
		assert.throws(() => parseJson('[1, 2'), /unexpected end of input/);
		assert.throws(() => parseJson("{'a': 1}"), /property name in double quotes/);
		assert.throws(() => parseJson('[1] x'), /unexpected text after/);
	});

	test('__proto__ is kept as an ordinary key', () => {
		const value = parseJson('{"__proto__": {"x": 1}, "a": 2}');
		assert.strictEqual(Object.getPrototypeOf(value), Object.prototype);
		assert.deepStrictEqual(Object.keys(value as object), ['__proto__', 'a']);
	});

	test('pretty printing indents nested values', () => {
		assert.strictEqual(
			stringifyJson(parseJson('{"a":[1,{"b":null}],"c":{}}'), '  '),
			'{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ],\n  "c": {}\n}'
		);
	});
});

suite('jsonUtils — reading records', () => {
	test('looksLikeJson tells JSON from bracketed SQL Server headers', () => {
		assert.strictEqual(looksLikeJson('[{"a":1}]'), true);
		assert.strictEqual(looksLikeJson('  {"a":1}'), true);
		assert.strictEqual(looksLikeJson('[1, 2]'), true);
		assert.strictEqual(looksLikeJson('[]'), true);
		assert.strictEqual(looksLikeJson('[id]\t[name]'), false);
		assert.strictEqual(looksLikeJson('[null_count],[x]'), false);
		assert.strictEqual(looksLikeJson('id,name'), false);
	});

	test('NDJSON is read one value per line', () => {
		assert.deepStrictEqual(parseJsonDocument('{"a":1}\n\n{"a":2}\n'), [{ a: new JsonNumber('1') }, { a: new JsonNumber('2') }]);
	});

	test('NDJSON errors name the right line', () => {
		assert.throws(() => parseJsonDocument('{"a":1}\n{"a":2}\n{"a":}'), /line 3/);
	});

	test('an API response is unwrapped to its array of records', () => {
		const { records, path } = parseJsonRecords('{"data": [{"id": 1}, {"id": 2}], "meta": {"page": 1}}');
		assert.strictEqual(records.length, 2);
		assert.strictEqual(path, '$.data');
	});

	test('an object with no single array of records is one record', () => {
		const { records, path } = parseJsonRecords('{"a": [1, 2], "b": [3]}');
		assert.strictEqual(records.length, 1);
		assert.strictEqual(path, '$');
	});

	test('recordsToTable unions keys and flattens nested objects', () => {
		assert.deepStrictEqual(
			recordsToTable(parseJson('[{"id":1,"addr":{"city":"Pune"}},{"id":2,"tags":["a","b"],"note":null}]') as JsonValue[]),
			[
				['id', 'addr.city', 'tags', 'note'],
				['1', 'Pune', '', ''],
				['2', '', '["a","b"]', '']
			]
		);
	});

	test('scalar records go in a value column', () => {
		assert.deepStrictEqual(recordsToTable(parseJson('["a", 2, true]') as JsonValue[]), [['value'], ['a'], ['2'], ['true']]);
	});

	test('an empty array is an error, not an empty table', () => {
		assert.throws(() => recordsToTable([]), /empty/);
	});
});

suite('jsonUtils — writing records', () => {
	const table = [['id', 'code', 'active', 'note'], ['1', '007', 'TRUE', ''], ['12345678901234567890', 'x', 'false', 'hi']];

	test('types are inferred, but zero-padded ids stay strings', () => {
		assert.strictEqual(
			tableToJson(table, 'ndjson', true),
			'{"id":1,"code":"007","active":true,"note":null}\n' +
			'{"id":12345678901234567890,"code":"x","active":false,"note":"hi"}'
		);
	});

	test('without inference everything is a string', () => {
		assert.strictEqual(
			tableToJson([['a', 'b'], ['1', '']], 'ndjson', false),
			'{"a":"1","b":""}'
		);
	});

	test('a JSON array is pretty-printed', () => {
		assert.strictEqual(tableToJson([['a'], ['1']], 'array', true), '[\n  {\n    "a": 1\n  }\n]');
	});

	test('duplicate and blank headers become distinct keys', () => {
		assert.deepStrictEqual(uniqueKeys(['id', 'id', '', 'id_2']), ['id', 'id_2', 'column_3', 'id_2_2']);
		assert.deepStrictEqual(Object.keys(tableToRecords([['x', 'x'], ['1', '2']], false)[0]), ['x', 'x_2']);
	});

	test('JSON round-trips through a table', () => {
		const json = '[{"id":1,"name":"O\'Brien, Pat"},{"id":2,"name":"Lee"}]';
		const back = tableToJson(recordsToTable(parseJsonRecords(json).records), 'array', true);
		assert.strictEqual(stringifyJson(parseJson(back)), json);
	});
});

suite('jsonUtils — extractJsonPath', () => {
	const doc = parseJson('{"data":[{"id":1,"tags":["a","b"],"owner":{"name":"Ann"}},{"id":2,"tags":[],"owner":null},{"tags":["c"]}]}');

	test('a JSONPath with wildcards', () => {
		assert.deepStrictEqual(extractJsonPath(doc, '$.data[*].id'), { values: ['1', '2'], missing: 1 });
	});

	test('a name applies to every element of an array', () => {
		assert.deepStrictEqual(extractJsonPath(doc, 'data.id').values, ['1', '2']);
	});

	test('a path ending on arrays lists their elements', () => {
		assert.deepStrictEqual(extractJsonPath(doc, 'data.tags').values, ['a', 'b', 'c']);
	});

	test('indexes, bracketed names and nulls', () => {
		assert.deepStrictEqual(extractJsonPath(doc, "$['data'][0].owner.name").values, ['Ann']);
		assert.deepStrictEqual(extractJsonPath(doc, 'data.owner.name'), { values: ['Ann'], missing: 2 });
	});

	test('objects come out as compact JSON', () => {
		assert.deepStrictEqual(extractJsonPath(doc, 'data[0].owner').values, ['{"name":"Ann"}']);
	});

	test('an invalid path is reported', () => {
		assert.throws(() => extractJsonPath(doc, 'data[x]'), /Invalid path/);
	});
});

suite('transformUtils — Markdown and structured input', () => {
	test('tableToMarkdown pads, escapes and right-aligns numbers', () => {
		assert.strictEqual(
			tableToMarkdown([['id', 'name'], ['1', 'a|b'], ['10', 'two\nlines']]),
			'|  id | name         |\n' +
			'| --: | ------------ |\n' +
			'|   1 | a\\|b         |\n' +
			'|  10 | two<br>lines |'
		);
	});

	test('a Markdown table round-trips', () => {
		const table = [['id', 'name'], ['1', 'a|b'], ['2', 'two\nlines']];
		assert.deepStrictEqual(parseMarkdownTable(tableToMarkdown(table)), table);
	});

	test('isMarkdownTable needs the delimiter row', () => {
		assert.strictEqual(isMarkdownTable('| a | b |\n|---|:-:|\n| 1 | 2 |'), true);
		assert.strictEqual(isMarkdownTable('a | b\n--- | ---\n1 | 2'), true);
		assert.strictEqual(isMarkdownTable('a|b\n1|2'), false);
	});

	test('parseStructuredTable reads JSON and says where from', () => {
		const result = parseStructuredTable('{"rows":[{"a":1}]}');
		assert.deepStrictEqual(result?.table, [['a'], ['1']]);
		assert.strictEqual(result?.note, 'Read 1 JSON record from $.rows.');
	});

	test('parseStructuredTable leaves delimited text alone', () => {
		assert.strictEqual(parseStructuredTable('a,b\n1,2'), null);
	});

	test('the SQL generator accepts JSON, ignoring the header flag', () => {
		const { headers, dataLines } = parseSqlTabularData('[{"id": 1, "full name": "Ann"}]', false);
		assert.deepStrictEqual(headers, ['id', 'full_name']);
		assert.deepStrictEqual(dataLines, [['1', 'Ann']]);
	});

	test('the SQL generator accepts a Markdown table', () => {
		const { headers, dataLines } = parseSqlTabularData('| id | name |\n|----|------|\n| 1 | Ann |');
		assert.deepStrictEqual(headers, ['id', 'name']);
		assert.deepStrictEqual(dataLines, [['1', 'Ann']]);
	});
});

suite('listUtils', () => {
	test('toLines drops only the empty line a trailing newline leaves', () => {
		assert.deepStrictEqual(toLines('a\r\nb\r\n'), ['a', 'b']);
		assert.deepStrictEqual(toLines('a\n\nb'), ['a', '', 'b']);
	});

	test('natural sort puts item2 before item10, ignoring case', () => {
		assert.deepStrictEqual(sortLines(['item10', 'Item2', 'item1', ''], 'natural'), ['item1', 'Item2', 'item10']);
		assert.deepStrictEqual(sortLines(['a', 'c', 'b'], 'naturalDesc'), ['c', 'b', 'a']);
	});

	test('numeric sort reads 1,234 and keeps non-numbers at the end', () => {
		assert.deepStrictEqual(
			sortLines(['10', 'n/a', '1,234', '-2', '9.5', 'abc'], 'numeric'),
			['-2', '9.5', '10', '1,234', 'abc', 'n/a']
		);
		assert.deepStrictEqual(sortLines(['1', '3', '2'], 'numericDesc'), ['3', '2', '1']);
	});

	test('reverse and length', () => {
		assert.deepStrictEqual(sortLines(['b', 'a', 'c'], 'reverse'), ['c', 'a', 'b']);
		assert.deepStrictEqual(sortLines(['ccc', 'a', 'bb'], 'length'), ['a', 'bb', 'ccc']);
	});

	test('identifier cases agree whatever the input style', () => {
		for (const input of ['Total Sales (USD)', 'totalSalesUSD', 'total-sales-usd', 'TOTAL_SALES_USD']) {
			assert.strictEqual(changeCase(input, 'snake'), 'total_sales_usd', input);
		}
		assert.strictEqual(changeCase('total sales', 'camel'), 'totalSales');
		assert.strictEqual(changeCase('total sales', 'pascal'), 'TotalSales');
		assert.strictEqual(changeCase('total sales', 'kebab'), 'total-sales');
		assert.strictEqual(changeCase('total sales', 'constant'), 'TOTAL_SALES');
		assert.strictEqual(changeCase('HTTPServer2', 'snake'), 'http_server2');
	});

	test('title case keeps apostrophes inside words', () => {
		assert.strictEqual(changeCase("o'brien AND the éclair", 'title'), "O'brien And The Éclair");
	});

	test('whitespace clean-up options are independent', () => {
		const lines = ['  a   b ', '', '\tc'];
		assert.deepStrictEqual(normaliseWhitespace(lines, { trim: true, collapse: true, dropBlank: true }), ['a b', 'c']);
		assert.deepStrictEqual(normaliseWhitespace(lines, { trim: true, collapse: false, dropBlank: false }), ['a   b', '', 'c']);
	});

	test('templates wrap each non-blank line', () => {
		assert.deepStrictEqual(applyTemplate(['a', '', 'b'], "'{}',"), ["'a',", '', "'b',"]);
		assert.deepStrictEqual(applyTemplate(['x'], '{} AS {}'), ['x AS x']);
		assert.throws(() => applyTemplate(['a'], 'no placeholder'), /\{\}/);
	});

	test('user regular expressions accept /pattern/flags and report errors', () => {
		assert.strictEqual(parseUserRegExp('/err/i').flags, 'i');
		assert.strictEqual(parseUserRegExp('a/b').source, 'a\\/b');
		assert.throws(() => parseUserRegExp('('), /Invalid regular expression/);
	});

	test('filterLines keeps or removes matches, even with a global regex', () => {
		const lines = ['ERROR a', 'info b', 'error c'];
		assert.deepStrictEqual(filterLines(lines, /error/gi, true), ['ERROR a', 'error c']);
		assert.deepStrictEqual(filterLines(lines, /error/i, false), ['info b']);
	});

	test('extractMatches returns matches, or capture groups tab-separated', () => {
		assert.deepStrictEqual(extractMatches('ids 12, 7 and 300', /\d+/), ['12', '7', '300']);
		assert.deepStrictEqual(extractMatches('a=1; b=2', /(\w)=(\d)/), ['a\t1', 'b\t2']);
		assert.deepStrictEqual(extractMatches('abc', /x*/), []);
	});

	test('dedupeByColumn keeps the first or last row per key', () => {
		const table = [['id', 'v'], ['1', 'old'], ['2', 'x'], ['1', 'new']];
		assert.deepStrictEqual(dedupeByColumn(table, 0, 'first', true), [['id', 'v'], ['1', 'old'], ['2', 'x']]);
		assert.deepStrictEqual(dedupeByColumn(table, 0, 'last', true), [['id', 'v'], ['2', 'x'], ['1', 'new']]);
		assert.deepStrictEqual(dedupeByColumn([['a'], ['a']], 0, 'first', false), [['a']]);
	});
});

suite('Extension', () => {
	test('all contributed commands are registered on activation', async () => {
		// Commands are contributed with no activation events, so nothing has
		// activated the extension yet — activate it explicitly, otherwise this
		// asserts a side effect it never triggered.
		const extension = vscode.extensions.getExtension('sid-dev.list-to-csv');
		assert.ok(extension, 'extension sid-dev.list-to-csv was not found');
		await extension.activate();
		assert.ok(extension.isActive, 'extension failed to activate');

		const registered = await vscode.commands.getCommands(true);
		const expected = [
			'list-to-csv.openWebview',
			'list-to-csv.transform',
			'list-to-csv.convert',
			'list-to-csv.convertToCommaLine',
			'list-to-csv.generateSQLTable',
			'list-to-csv.countValues',
			'list-to-csv.removeDuplicates',
			'list-to-csv.compareColumns',
			'list-to-csv.lastUsedConfigurations',
			'list-to-csv.openSettings'
		];
		for (const command of expected) {
			assert.ok(registered.includes(command), `${command} is not registered`);
		}
	});

	test('Transform Selection replaces the selection and keeps its trailing newline', async () => {
		const document = await vscode.workspace.openTextDocument({ content: 'item10\nb\nitem2\n', language: 'plaintext' });
		const editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(0, 0, 3, 0);

		// Answer the two quick-picks: the transform, then the sort order.
		type Item = vscode.QuickPickItem & { mode?: string };
		const answers: ((items: Item[]) => Item | undefined)[] = [
			items => items.find(item => item.label.includes('Sort lines')),
			items => items.find(item => item.mode === 'natural')
		];
		const window = vscode.window as { showQuickPick: unknown };
		const original = window.showQuickPick;
		window.showQuickPick = async (items: Item[] | Thenable<Item[]>) => answers.shift()?.(await items);
		try {
			await vscode.commands.executeCommand('list-to-csv.transform');
		} finally {
			window.showQuickPick = original;
		}

		assert.strictEqual(answers.length, 0, 'not every prompt was shown');
		assert.strictEqual(document.getText(), 'b\nitem2\nitem10\n');
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
	});
});
