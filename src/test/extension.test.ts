import * as assert from 'assert';
import * as vscode from 'vscode';

import {
	detectSeparator,
	formatSqlValue,
	getDefaultDataType,
	inferSqlDataType,
	isPlainNumber,
	needsQuoting,
	parseDelimitedLine,
	parseDelimitedText,
	quoteIdentifier,
	sanitizeColumnNames,
	TIMESTAMP_PATTERN
} from '../utils/sqlUtils';
import { escapeHtml, escapeRegExp, getNonce } from '../utils/htmlUtils';

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
});
