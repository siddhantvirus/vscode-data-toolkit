/**
 * Data Toolkit panel script.
 *
 * Bundled separately by esbuild and loaded via asWebviewUri, so it can import
 * the same helpers the extension host uses instead of keeping hand-written
 * copies of them. Those copies previously drifted: missing statement
 * terminators survived in three dialects because the fix only landed in one
 * of the two implementations.
 */
import {
    detectSeparator as detectSep,
    formatSqlValue as fmtSqlVal,
    getDefaultDataType as getDefaultType,
    inferSqlDataType,
    joinAsDelimitedLine,
    parseDelimitedText,
    quoteIdentifier,
    sanitizeColumnNames
} from "../utils/sqlUtils";
import { diffRows, suggestKeyColumn } from "../utils/diffUtils";
import { escapeHtml as escHtml } from "../utils/htmlUtils";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

/**
 * Typed element lookup. The panel renders its own markup, so every id here is
 * known to exist; defaulting to HTMLInputElement means .value and .checked
 * resolve without a cast at each of the ~70 call sites.
 */
function el<T extends HTMLElement = HTMLInputElement>(id: string): T {
    return document.getElementById(id) as unknown as T;
}

/** Adapt the panel checkbox (boolean) to the shared enum. */
function quoteId(name, dialect, always) {
    return quoteIdentifier(name, dialect, always ? "always" : "auto");
}

var vscode = acquireVsCodeApi();

/* ── Event delegation ────────────────────────────── */
/* The Content-Security-Policy above blocks inline handlers, so buttons declare
   a data-action and are dispatched through this table. It also covers markup
   rendered later (the formula builder) without rebinding. */
var ACTIONS: Record<string, (arg?: string | null) => void> = {};

document.addEventListener('click', function(e) {
    var target = e.target as HTMLElement;
    var actionEl = target.closest ? target.closest('[data-action]') : null;
    if (!actionEl) { return; }
    var fn = ACTIONS[actionEl.getAttribute('data-action')];
    if (fn) { fn(actionEl.getAttribute('data-arg')); }
});

/* ── Tab switching ───────────────────────────────── */
document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        var tab = btn.getAttribute('data-tab');
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
        btn.classList.add('active');
        el('tab-' + tab).classList.add('active');
    });
});

function switchToTab(name) {
    var btn = document.querySelector('.tab-btn[data-tab="' + name + '"]') as HTMLElement | null;
    if (btn) { btn.click(); }
}

/* ── Message handler ─────────────────────────────── */
window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.command) {
        case 'setContent':
            /* Never clobber text the user already has in the Convert tab. */
            var input = el('listInput');
            if (msg.replace !== false || !input.value.trim()) { input.value = msg.content; }
            break;
        case 'switchToTab':
            switchToTab(msg.tab);
            break;
        case 'setCompareColumnA':
            el('compareColA').value = msg.content;
            break;
    }
});

/* ═══ TAB 1: CONVERT ════════════════════════════════════════ */
function getConvertLines() {
    /* Split on CRLF as well as LF — a stray \r would otherwise end up inside
       the quotes when the list was pasted from a Windows file. */
    var lines = el('listInput').value
        .split(/\r?\n/)
        .map(function(l) { return l.trim(); })
        .filter(function(l) { return l !== ''; });
    if (el('convertDedup').checked) {
        var seen = Object.create(null);
        lines = lines.filter(function(l) {
            if (seen[l]) { return false; }
            seen[l] = true;
            return true;
        });
    }
    return lines;
}

function getConvertResult() {
    var lines = getConvertLines();
    if (!lines.length) { return null; }
    return joinAsDelimitedLine(lines, {
        separator: el('separator').value || ',',
        enclosure: (document.querySelector('input[name="enc"]:checked') as HTMLInputElement).value,
        sqlInClause: el('sqlIn').checked
    });
}

function convertPreview() {
    var result = getConvertResult();
    if (!result) { showStatus('convertStatus', 'Please enter some values.', false); return; }
    var box = el('convertPreviewBox');
    box.textContent = result;
    box.classList.remove('hidden');
    hideStatus('convertStatus');
}

function convertAndCopy() {
    var result = getConvertResult();
    if (!result) { showStatus('convertStatus', 'Please enter some values.', false); return; }
    var count = getConvertLines().length;
    navigator.clipboard.writeText(result).then(function() {
        var box = el('convertPreviewBox');
        box.textContent = result;
        box.classList.remove('hidden');
        showStatus('convertStatus', 'Copied ' + count + ' items to clipboard!', true);
        vscode.postMessage({ command: 'convertAndCopy', count: count });
    }).catch(function(err) {
        showStatus('convertStatus', 'Copy failed: ' + err, false);
    });
}

/* ═══ TAB 2: COUNT & DEDUPE ═════════════════════════════════ */
var analyzeLastResult = '';

function getAnalyzeLines() {
    var text = el('analyzeInput').value;
    var trim = el('analyzeTrim').checked;
    var cs = el('analyzeCaseSensitive').checked;
    var lines = text.split(/\r?\n/).filter(function(l) { return l.trim() !== ''; });
    if (trim) { lines = lines.map(function(l) { return l.trim(); }); }
    if (!cs) { lines = lines.map(function(l) { return l.toLowerCase(); }); }
    return lines;
}

function doCountValues() {
    var lines = getAnalyzeLines();
    if (!lines.length) { showStatus('analyzeStatus', 'No values found.', false); return; }
    var counts = {};
    lines.forEach(function(l) { counts[l] = (counts[l] || 0) + 1; });
    var sorted = Object.keys(counts).sort(function(a, b) { return counts[b] - counts[a] || a.localeCompare(b); });
    var isCsv = el('fmtCsv').checked;
    var delim = isCsv ? ',' : '\t';
    var header = isCsv ? 'value,count' : 'value\tcount';
    var rows = sorted.map(function(v) {
        var cell = isCsv && (v.indexOf(',') !== -1 || v.indexOf('"') !== -1) ? '"' + v.replace(/"/g, '""') + '"' : v;
        return cell + delim + counts[v];
    });
    analyzeLastResult = header + '\n' + rows.join('\n');
    el('analyzeMeta').textContent = sorted.length + ' unique values from ' + lines.length + ' total. Top: ' + sorted.slice(0, 3).join(', ');
    el('analyzeOutput').textContent = analyzeLastResult;
    el('analyzeResult').classList.remove('hidden');
    hideStatus('analyzeStatus');
}

function doDedup() {
    var lines = getAnalyzeLines();
    if (!lines.length) { showStatus('analyzeStatus', 'No values found.', false); return; }
    var seen = {};
    var unique = [];
    lines.forEach(function(l) { if (!seen[l]) { seen[l] = true; unique.push(l); } });
    var removed = lines.length - unique.length;
    analyzeLastResult = unique.join('\n');
    el('analyzeMeta').textContent = unique.length + ' unique values (' + removed + ' duplicates removed)';
    el('analyzeOutput').textContent = analyzeLastResult;
    el('analyzeResult').classList.remove('hidden');
    hideStatus('analyzeStatus');
}

function copyAnalyze() {
    if (!analyzeLastResult) { return; }
    navigator.clipboard.writeText(analyzeLastResult).then(function() {
        vscode.postMessage({ command: 'copySuccess', text: 'Results copied to clipboard!' });
    });
}

/* ═══ TAB 3: COMPARE COLUMNS ════════════════════════════════ */
var compareData = { A: [], common: [], B: [] };

/* ── Row diff ───────────────────────────────────── */
/* Mirrors diffRows / suggestKeyColumn in src/utils/diffUtils.ts. */
var cmpMode = 'values';

function setCompareMode(mode) {
    cmpMode = mode;
    document.querySelectorAll('.mode-btn').forEach(function(b) {
        b.classList.toggle('active', b.getAttribute('data-cmpmode') === mode);
    });
    var rowsMode = mode === 'rows';
    el('cmpRowOptions').classList.toggle('hidden', !rowsMode);
    el('labelColA').textContent = rowsMode ? 'Table A (with header row):' : 'Column A:';
    el('labelColB').textContent = rowsMode ? 'Table B (with header row):' : 'Column B:';
    var ph = rowsMode ? 'Paste tabular data, first row is the header...' : 'Paste values (one per line)...';
    el('compareColA').placeholder = ph;
    el('compareColB').placeholder = ph;

    /* Only one result view is meaningful at a time. */
    el('compareResults').classList.add('hidden');
    el('diffResults').classList.add('hidden');
    el('diffSummary').classList.add('hidden');
    el('diffWarnings').innerHTML = '';
    hideStatus('compareStatus');

    if (rowsMode) { refreshKeyOptions(); }
}

function readTable(id) {
    var raw = el(id).value;
    if (!raw.trim()) { return null; }
    var firstLine = raw.split(/\r?\n/)[0];
    var sep = detectSep(firstLine);
    if (!sep) { return null; }
    var rows = parseDelimitedText(raw, sep);
    return rows.length ? rows : null;
}

/* Populate the key dropdown from the shared headers, pre-selecting a column
   that is unique on both sides so the common case needs no interaction. */
function refreshKeyOptions() {
    var select = el('cmpKey');
    var a = readTable('compareColA');
    var b = readTable('compareColB');
    if (!a || !b) {
        select.innerHTML = '<option value="">Load data to pick a key…</option>';
        return;
    }
    var shared = a[0].filter(function(h) { return b[0].indexOf(h) !== -1; });
    if (!shared.length) {
        select.innerHTML = '<option value="">No shared columns</option>';
        return;
    }
    var previous = select.value;
    var suggested = suggestKeyColumn(a, b);
    select.innerHTML = shared.map(function(h) {
        return '<option value="' + escHtml(h) + '">' + escHtml(h) + '</option>';
    }).join('');
    select.value = shared.indexOf(previous) !== -1 ? previous : (suggested || shared[0]);
}

/** Cap rendered diff rows; a large diff would otherwise lock the panel. */
var DIFF_ROW_LIMIT = 300;

function renderDiff(result, keyColumn, showUnchanged) {
    var warnBox = el('diffWarnings');
    warnBox.innerHTML = result.warnings.map(function(w) {
        return '<div class="diff-warning">' + escHtml(w) + '</div>';
    }).join('');

    var c = result.counts;
    var summary = el('diffSummary');
    summary.innerHTML =
        stat('chip-added','+', c.added, 'added') +
        stat('chip-removed','−', c.removed, 'removed') +
        stat('chip-changed','~', c.changed, 'changed') +
        stat('chip-unchanged','=', c.unchanged, 'unchanged');
    summary.classList.remove('hidden');

    var visible = result.rows.filter(function(r) { return showUnchanged || r.status !== 'unchanged'; });
    var shown = visible.slice(0, DIFF_ROW_LIMIT);
    var glyph = { added:'+', removed:'−', changed:'~', unchanged:'=' };

    var head = '<tr><th></th>' + result.columns.map(function(col) {
        return '<th>' + escHtml(col) + (col === keyColumn ? ' · key' : '') + '</th>';
    }).join('') + '</tr>';

    var body = shown.map(function(r) {
        var cells = result.columns.map(function(col) {
            var change = r.changes.filter(function(ch) { return ch.column === col; })[0];
            if (change) {
                return '<td class="cell-changed"><span class="val-before">' + escHtml(change.before) +
                       '</span><span class="val-arrow">→</span><span class="val-after">' +
                       escHtml(change.after) + '</span></td>';
            }
            var source = r.after || r.before || {};
            return '<td>' + escHtml(source[col] === undefined || source[col] === null ? '' : source[col]) + '</td>';
        }).join('');
        return '<tr class="row-' + r.status + '"><td class="status" title="' + r.status + '">' +
               glyph[r.status] + '</td>' + cells + '</tr>';
    }).join('');

    var truncated = visible.length > shown.length
        ? '<div class="diff-truncated">Showing ' + shown.length + ' of ' + visible.length + ' rows.</div>'
        : '';

    var out = el('diffResults');
    out.innerHTML = visible.length
        ? '<div class="diff-scroll"><table class="diff"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' + truncated
        : '<p class="empty-hint">No differences.' + (c.unchanged ? ' ' + c.unchanged + ' rows are identical.' : '') + '</p>';
    out.classList.remove('hidden');

    function stat(cls, sign, n, label) {
        return '<span class="diff-stat"><span class="diff-chip ' + cls + '">' + sign + '</span>' + n + ' ' + label + '</span>';
    }
}

function doCompareRows() {
    var a = readTable('compareColA');
    var b = readTable('compareColB');
    if (!a || !b) {
        showStatus('compareStatus', 'Paste tabular data with a header row into both sides.', false);
        return;
    }
    refreshKeyOptions();
    var key = el('cmpKey').value;
    if (!key) {
        showStatus('compareStatus', 'No shared column to match rows on.', false);
        return;
    }
    hideStatus('compareStatus');
    el('compareResults').classList.add('hidden');
    var result = diffRows(a, b, key, {
        caseSensitive: el('cmpCase').checked,
        trim: el('cmpTrim').checked
    });
    renderDiff(result, key, el('cmpShowUnchanged').checked);
}

function doCompare() {
    if (cmpMode === 'rows') { doCompareRows(); return; }

    el('diffResults').classList.add('hidden');
    el('diffSummary').classList.add('hidden');
    el('diffWarnings').innerHTML = '';

    var cs = el('cmpCase').checked;
    var trim = el('cmpTrim').checked;

    function parseCol(id) {
        var lines = el(id).value.split(/\r?\n/).filter(function(l) { return l.trim() !== ''; });
        if (trim) { lines = lines.map(function(l) { return l.trim(); }); }
        if (!cs) { lines = lines.map(function(l) { return l.toLowerCase(); }); }
        return lines;
    }

    var a = parseCol('compareColA');
    var b = parseCol('compareColB');
    var setA = {};
    var setB = {};
    a.forEach(function(v) { setA[v] = true; });
    b.forEach(function(v) { setB[v] = true; });

    var onlyA = Object.keys(setA).filter(function(v) { return !setB[v]; }).sort();
    var common = Object.keys(setA).filter(function(v) { return setB[v]; }).sort();
    var onlyB = Object.keys(setB).filter(function(v) { return !setA[v]; }).sort();

    compareData = { A: onlyA, common: common, B: onlyB };

    renderCompareList('listA', 'cntA', onlyA);
    renderCompareList('listCommon', 'cntCommon', common);
    renderCompareList('listB', 'cntB', onlyB);
    el('compareResults').classList.remove('hidden');
}

function renderCompareList(listId, cntId, items) {
    el(cntId).textContent = items.length + ' item' + (items.length !== 1 ? 's' : '');
    var listEl = el(listId);
    if (!items.length) {
        listEl.innerHTML = '<span class="empty-hint">None</span>';
    } else {
        listEl.innerHTML = items.map(function(v) {
            return '<div class="result-item">' + escHtml(v) + '</div>';
        }).join('');
    }
}

function copyCompare(key) {
    var items = compareData[key];
    if (!items || !items.length) { return; }
    navigator.clipboard.writeText(items.join('\n')).then(function() {
        vscode.postMessage({ command: 'copySuccess', text: 'Copied ' + items.length + ' items to clipboard!' });
    });
}

/* ═══ TAB 4: SQL BUILDER ════════════════════════════════════ */
function generateSQL() {
    var raw = el('sqlInput').value;
    var lines = raw.split(/\r?\n/).filter(function(l) { return l.trim() !== ''; });
    if (!lines.length) { showStatus('sqlStatus', 'No data found.', false); return; }

    var dialect  = el('sqlDialect').value;
    var hasHdr   = el('sqlHeaders').checked;
    var infer    = el('sqlInferTypes').checked;
    var genCre   = el('sqlGenCreate').checked;
    var genIns   = el('sqlGenInsert').checked;
    var sizeVar  = el('sqlSizeVarchar').checked;
    var alwaysQ  = el('sqlAlwaysQuote').checked;

    /* Read alwaysQ before quoting: with var hoisting, computing tbl above this
       point silently saw undefined and ignored the setting. */
    var tblRaw   = el('sqlTable').value.trim() || 'my_table';
    var tbl      = quoteId(tblRaw, dialect, alwaysQ);

    var sep = detectSep(lines[0]);
    var headers, dataRows;

    if (sep) {
        /* Parse the whole document rather than line by line, so quoting is
           honoured across newlines. */
        var rows = parseDelimitedText(raw, sep);
        if (!rows.length) { showStatus('sqlStatus', 'No data found.', false); return; }
        if (hasHdr) {
            headers  = sanitizeColumnNames(rows[0]);
            dataRows = rows.slice(1);
        } else {
            headers  = Array.from({ length: rows[0].length }, function(_, i) { return 'col' + (i + 1); });
            dataRows = rows;
        }
    } else {
        headers  = hasHdr && lines.length ? sanitizeColumnNames([lines[0].trim()]) : ['value'];
        dataRows = hasHdr ? lines.slice(1).map(function(l) { return [l.trim()]; })
                          : lines.map(function(l) { return [l.trim()]; });
    }

    var sql = '';

    if (genCre) {
        sql += 'CREATE TABLE ' + tbl + ' (\n';
        headers.forEach(function(h, i) {
            // inferSqlDataType takes the whole table and a column index; it
            // extracts and filters the column itself.
            var type = infer
                ? inferSqlDataType(dataRows, i, dialect, sizeVar ? 'fromSample' : 'fixed')
                : getDefaultType(dialect);
            sql += '    ' + quoteId(h, dialect, alwaysQ) + ' ' + type;
            sql += i < headers.length - 1 ? ',\n' : '\n';
        });
        sql += ')';
        if (dialect === 'spark') { sql += '\nUSING DELTA'; }
        if (dialect === 'mysql') { sql += '\nENGINE=InnoDB DEFAULT CHARSET=utf8mb4'; }
        /* Terminate for every dialect, not just postgres — an unterminated
           CREATE TABLE fails once the script is run as multiple statements. */
        sql += ';\n';
    }

    if (genIns && dataRows.length) {
        var colList = headers.map(function(h) { return quoteId(h, dialect, alwaysQ); }).join(', ');
        sql += '\nINSERT INTO ' + tbl + ' (' + colList + ') VALUES\n';
        sql += dataRows.map(function(row) {
            var vals = headers.map(function(_, ci) {
                return fmtSqlVal(ci < row.length ? row[ci] : '', infer);
            });
            return '    (' + vals.join(', ') + ')';
        }).join(',\n');
        sql += ';\n';
    }

    var out = el('sqlOutput');
    out.textContent = sql;
    out.classList.remove('hidden');

    /* Say what happened where the user is looking. Generating does not copy —
       that is what the Copy SQL and Open in Editor buttons are for. */
    showStatus('sqlStatus',
        'Generated ' + (genCre ? 'CREATE TABLE' : '') +
        (genCre && genIns ? ' + ' : '') +
        (genIns ? dataRows.length + ' INSERT row' + (dataRows.length === 1 ? '' : 's') : '') +
        ' for ' + dialect.toUpperCase() + '. Not copied yet — use Copy SQL or Open in Editor.', true);

    vscode.postMessage({ command: 'sqlGenerated', dialect: dialect });
}

function currentSql() {
    var text = el('sqlOutput').textContent;
    if (!text) {
        generateSQL();
        text = el('sqlOutput').textContent;
    }
    return text;
}

function copySQL() {
    var text = currentSql();
    if (!text) { return; }
    navigator.clipboard.writeText(text).then(function() {
        vscode.postMessage({ command: 'copySuccess', text: 'SQL copied to clipboard!' });
    });
}

function openSqlInEditor() {
    var text = currentSql();
    if (!text) { return; }
    vscode.postMessage({ command: 'openInEditor', text: text });
}

/* ═══ TAB 5: EXCEL FORMULAS ═════════════════════════════════ */
var CATEGORIES = [
    { id: 'lookup',      label: 'Lookup' },
    { id: 'aggregation', label: 'Aggregation' },
    { id: 'text',        label: 'Text' },
    { id: 'date',        label: 'Date & Time' },
    { id: 'logic',       label: 'Logic & Filter' }
];

var FORMULAS = {
    lookup: [
        {
            name: 'VLOOKUP',
            desc: 'Find a value in the first column, return from another column.',
            params: [
                { id: 'lv',  label: 'Lookup Value',  ph: 'A2',           hint: 'Cell or value to search for' },
                { id: 'ta',  label: 'Table Range',   ph: 'Sheet2!A:D',   hint: 'Range containing the data table' },
                { id: 'ci',  label: 'Column Number', ph: '3',            hint: 'Column to return (1 = first column of range)' },
                { id: 'ex',  label: 'Match Type',    ph: 'FALSE',        hint: 'FALSE = exact match (recommended)', type: 'select', opts: ['FALSE', 'TRUE'] }
            ],
            tpl: '=VLOOKUP({lv}, {ta}, {ci}, {ex})',
            tip: 'Use FALSE for exact match. Only searches the leftmost column — use INDEX/MATCH to search any column.'
        },
        {
            name: 'XLOOKUP',
            desc: 'Modern VLOOKUP replacement — searches any column, returns any direction. (Excel 365 / 2021+)',
            params: [
                { id: 'lv', label: 'Lookup Value',   ph: 'A2',           hint: 'Value to search for' },
                { id: 'la', label: 'Search Column',  ph: 'Sheet2!A:A',   hint: 'Column to search in' },
                { id: 'ra', label: 'Return Column',  ph: 'Sheet2!C:C',   hint: 'Column to return values from' },
                { id: 'nf', label: 'If Not Found',   ph: '"N/A"',        hint: 'Value to show when no match is found' }
            ],
            tpl: '=XLOOKUP({lv}, {la}, {ra}, {nf})',
            tip: 'Preferred over VLOOKUP — no column index needed, can search left, handles missing values cleanly.'
        },
        {
            name: 'INDEX / MATCH',
            desc: 'Flexible two-step lookup that works in any direction.',
            params: [
                { id: 'rc', label: 'Return Column',  ph: 'Sheet2!C:C',   hint: 'Column to retrieve the value from' },
                { id: 'lv', label: 'Lookup Value',   ph: 'A2',           hint: 'Value to search for' },
                { id: 'lc', label: 'Search Column',  ph: 'Sheet2!A:A',   hint: 'Column to search in' }
            ],
            tpl: '=INDEX({rc}, MATCH({lv}, {lc}, 0))',
            tip: 'The 0 in MATCH means exact. More robust than VLOOKUP — column order does not matter.'
        }
    ],
    aggregation: [
        {
            name: 'SUMIF',
            desc: 'Sum values in a range where one condition is met.',
            params: [
                { id: 'cr', label: 'Criteria Range', ph: 'B:B',      hint: 'Range to test the condition against' },
                { id: 'c',  label: 'Criteria',       ph: '"Sales"',   hint: 'Condition (value, text, or expression like >100)' },
                { id: 'sr', label: 'Sum Range',      ph: 'C:C',      hint: 'Range of values to sum' }
            ],
            tpl: '=SUMIF({cr}, {c}, {sr})',
            tip: 'For multiple conditions use SUMIFS.'
        },
        {
            name: 'SUMIFS',
            desc: 'Sum values where multiple conditions are all met.',
            params: [
                { id: 'sr',  label: 'Sum Range',       ph: 'D:D',      hint: 'Range of values to sum' },
                { id: 'cr1', label: 'Criteria 1 Range',ph: 'B:B',      hint: 'First range to evaluate' },
                { id: 'c1',  label: 'Criteria 1',      ph: '"Sales"',   hint: 'First condition' },
                { id: 'cr2', label: 'Criteria 2 Range',ph: 'C:C',      hint: 'Second range to evaluate' },
                { id: 'c2',  label: 'Criteria 2',      ph: '"2024"',    hint: 'Second condition' }
            ],
            tpl: '=SUMIFS({sr}, {cr1}, {c1}, {cr2}, {c2})',
            tip: 'Add more range/criteria pairs to filter further. Use ">0" or "<>""" as criteria expressions.'
        },
        {
            name: 'COUNTIF',
            desc: 'Count cells where one condition is met.',
            params: [
                { id: 'r', label: 'Range',    ph: 'B:B',     hint: 'Range to evaluate' },
                { id: 'c', label: 'Criteria', ph: '"Sales"', hint: 'Condition to match' }
            ],
            tpl: '=COUNTIF({r}, {c})',
            tip: 'Wildcards work: "Sales*" matches anything starting with Sales.'
        },
        {
            name: 'COUNTIFS',
            desc: 'Count cells where multiple conditions are all met.',
            params: [
                { id: 'cr1', label: 'Criteria 1 Range', ph: 'B:B',    hint: 'First range to evaluate' },
                { id: 'c1',  label: 'Criteria 1',       ph: '"Sales"', hint: 'First condition' },
                { id: 'cr2', label: 'Criteria 2 Range', ph: 'C:C',    hint: 'Second range to evaluate' },
                { id: 'c2',  label: 'Criteria 2',       ph: '">0"',   hint: 'Second condition' }
            ],
            tpl: '=COUNTIFS({cr1}, {c1}, {cr2}, {c2})'
        },
        {
            name: 'AVERAGEIF',
            desc: 'Average values in a range where a condition is met.',
            params: [
                { id: 'cr', label: 'Criteria Range', ph: 'B:B',     hint: 'Range to test the condition' },
                { id: 'c',  label: 'Criteria',       ph: '"North"',  hint: 'Condition to match' },
                { id: 'ar', label: 'Average Range',  ph: 'C:C',     hint: 'Range of values to average' }
            ],
            tpl: '=AVERAGEIF({cr}, {c}, {ar})'
        }
    ],
    text: [
        {
            name: 'TEXTJOIN',
            desc: 'Join multiple values with a delimiter, skipping blanks.',
            params: [
                { id: 'd', label: 'Delimiter',      ph: '", "',  hint: 'Text between each value (include quotes)' },
                { id: 'ie',label: 'Ignore Empty',   ph: 'TRUE',  hint: 'TRUE to skip empty cells', type: 'select', opts: ['TRUE', 'FALSE'] },
                { id: 'r', label: 'Range / Values', ph: 'A2:A100', hint: 'Range of values to join' }
            ],
            tpl: '=TEXTJOIN({d}, {ie}, {r})',
            tip: 'Great for building comma-separated lists from a column. Combine with UNIQUE: =TEXTJOIN(", ", TRUE, UNIQUE(A:A))'
        },
        {
            name: 'CONCAT',
            desc: 'Join two or more values into one text string.',
            params: [
                { id: 't1', label: 'Text 1', ph: 'A2',  hint: 'First value (cell reference or quoted text)' },
                { id: 't2', label: 'Text 2', ph: '" "', hint: 'Second value (use " " for a space)' },
                { id: 't3', label: 'Text 3 (optional)', ph: 'B2', hint: 'Third value — leave empty to omit' }
            ],
            tpl: '=CONCAT({t1}, {t2}, {t3})',
            tip: 'Quick alternative: use & operator — =A2&" "&B2'
        },
        {
            name: 'LEFT',
            desc: 'Extract characters from the start of a text string.',
            params: [
                { id: 't', label: 'Text / Cell',     ph: 'A2', hint: 'The text to extract from' },
                { id: 'n', label: 'Num Characters',  ph: '5',  hint: 'How many characters to extract' }
            ],
            tpl: '=LEFT({t}, {n})'
        },
        {
            name: 'MID',
            desc: 'Extract characters from the middle of a text string.',
            params: [
                { id: 't', label: 'Text / Cell',    ph: 'A2', hint: 'The text to extract from' },
                { id: 's', label: 'Start Position', ph: '3',  hint: 'Where to start (1 = first character)' },
                { id: 'n', label: 'Num Characters', ph: '5',  hint: 'How many characters to extract' }
            ],
            tpl: '=MID({t}, {s}, {n})'
        },
        {
            name: 'TEXT',
            desc: 'Format a number or date as text with a custom format.',
            params: [
                { id: 'v', label: 'Value / Cell',  ph: 'A2',          hint: 'Number or date to format' },
                { id: 'f', label: 'Format Code',   ph: '"YYYY-MM-DD"', hint: 'Format string — see tip for examples' }
            ],
            tpl: '=TEXT({v}, {f})',
            tip: 'Common formats: "YYYY-MM-DD", "DD/MM/YYYY", "0.00%", "$#,##0.00", "#,##0", "MMM YYYY"'
        },
        {
            name: 'SUBSTITUTE',
            desc: 'Replace specific text within a string.',
            params: [
                { id: 't',  label: 'Text / Cell',    ph: 'A2',  hint: 'The text to modify' },
                { id: 'old',label: 'Find Text',       ph: '"_"', hint: 'Text to replace (in quotes)' },
                { id: 'new',label: 'Replace With',    ph: '" "', hint: 'Replacement text (in quotes)' }
            ],
            tpl: '=SUBSTITUTE({t}, {old}, {new})',
            tip: 'Add a 4th argument to replace only the Nth occurrence: =SUBSTITUTE(A2, "-", "/", 2)'
        }
    ],
    date: [
        {
            name: 'DATEDIF',
            desc: 'Calculate the difference between two dates.',
            params: [
                { id: 'sd', label: 'Start Date', ph: 'A2', hint: 'Start date (cell reference or date)' },
                { id: 'ed', label: 'End Date',   ph: 'B2', hint: 'End date' },
                { id: 'u',  label: 'Unit',       ph: '"D"', hint: '"D"=days, "M"=months, "Y"=years', type: 'select', opts: ['"D"', '"M"', '"Y"', '"MD"', '"YM"', '"YD"'] }
            ],
            tpl: '=DATEDIF({sd}, {ed}, {u})',
            tip: '"MD" = days ignoring months/years; "YM" = months ignoring years — useful for "X years, Y months" displays.'
        },
        {
            name: 'EOMONTH',
            desc: 'Return the last day of the month, N months from a date.',
            params: [
                { id: 'd', label: 'Start Date',     ph: 'A2', hint: 'Reference date' },
                { id: 'm', label: 'Months Offset',  ph: '0',  hint: '0 = current month end, -1 = last month, 1 = next month' }
            ],
            tpl: '=EOMONTH({d}, {m})',
            tip: 'Use =EOMONTH(TODAY(), 0) for end of current month. Wrap with TEXT() to format as a date string.'
        },
        {
            name: 'NETWORKDAYS',
            desc: 'Count working days (Mon–Fri) between two dates, excluding holidays.',
            params: [
                { id: 'sd', label: 'Start Date',             ph: 'A2',    hint: 'Start date' },
                { id: 'ed', label: 'End Date',               ph: 'B2',    hint: 'End date' },
                { id: 'h',  label: 'Holidays Range (opt.)',  ph: 'D2:D20', hint: 'Optional range of holiday dates to exclude' }
            ],
            tpl: '=NETWORKDAYS({sd}, {ed}, {h})'
        },
        {
            name: 'YEAR / MONTH / DAY',
            desc: 'Extract the year, month, or day component from a date.',
            params: [
                { id: 'fn', label: 'Function', ph: 'YEAR', type: 'select', opts: ['YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND'] },
                { id: 'd',  label: 'Date / Cell', ph: 'A2', hint: 'The date to extract from' }
            ],
            tpl: '={fn}({d})'
        }
    ],
    logic: [
        {
            name: 'IFERROR',
            desc: 'Return a custom value when a formula produces any error.',
            params: [
                { id: 'f', label: 'Formula',       ph: 'VLOOKUP(A2,Sheet2!A:B,2,FALSE)', hint: 'The formula to evaluate' },
                { id: 'e', label: 'If Error',      ph: '"Not Found"', hint: 'What to show if there is an error' }
            ],
            tpl: '=IFERROR({f}, {e})',
            tip: 'Wraps any formula to suppress #N/A, #VALUE!, #REF! errors. Essential for VLOOKUP / XLOOKUP pipelines.'
        },
        {
            name: 'IFS',
            desc: 'Test multiple conditions, return the first match. (Excel 2016+)',
            params: [
                { id: 'c1', label: 'Condition 1',      ph: 'A2>90',  hint: 'First condition to test' },
                { id: 'v1', label: 'Value if True 1',  ph: '"A"',    hint: 'Return this if Condition 1 is true' },
                { id: 'c2', label: 'Condition 2',      ph: 'A2>75',  hint: 'Second condition' },
                { id: 'v2', label: 'Value if True 2',  ph: '"B"',    hint: 'Return this if Condition 2 is true' },
                { id: 'dv', label: 'Default (else)',   ph: '"C"',    hint: 'Catch-all (condition = TRUE)' }
            ],
            tpl: '=IFS({c1}, {v1}, {c2}, {v2}, TRUE, {dv})',
            tip: 'Cleaner than nested IF(). Add as many condition/value pairs as needed before the TRUE default.'
        },
        {
            name: 'UNIQUE',
            desc: 'Return distinct values from a range. (Excel 365 / Google Sheets)',
            params: [
                { id: 'a',  label: 'Range',      ph: 'A2:A100',  hint: 'Range to extract unique values from' },
                { id: 'bc', label: 'By Column',  ph: 'FALSE', hint: 'FALSE = unique rows, TRUE = unique columns', type: 'select', opts: ['FALSE', 'TRUE'] }
            ],
            tpl: '=UNIQUE({a}, {bc})',
            tip: 'Results spill automatically. Combine: =SORT(UNIQUE(A2:A100)) or =TEXTJOIN(", ", TRUE, UNIQUE(A:A))'
        },
        {
            name: 'FILTER',
            desc: 'Return rows from a range that match a condition. (Excel 365 / Google Sheets)',
            params: [
                { id: 'a',  label: 'Data Range',    ph: 'A2:C100',         hint: 'Range to filter' },
                { id: 'c',  label: 'Condition',     ph: 'B2:B100="Sales"', hint: 'Boolean array — rows where TRUE are returned' },
                { id: 'nf', label: 'If No Results', ph: '"No data"',        hint: 'Value when no rows match' }
            ],
            tpl: '=FILTER({a}, {c}, {nf})',
            tip: 'AND: (B2:B100="Sales")*(C2:C100>1000)   OR: (B2:B100="Sales")+(C2:C100="HR")'
        },
        {
            name: 'SORT',
            desc: 'Sort a range or array. (Excel 365 / Google Sheets)',
            params: [
                { id: 'a',  label: 'Range / Array',   ph: 'A2:C100', hint: 'Data to sort' },
                { id: 'si', label: 'Sort Column',     ph: '1',       hint: 'Column index to sort by (1 = first)' },
                { id: 'so', label: 'Order',           ph: '1', type: 'select', opts: ['1 (Ascending)', '-1 (Descending)'] }
            ],
            tpl: '=SORT({a}, {si}, {so})',
            tip: 'Chain with FILTER: =SORT(FILTER(A2:C100, B2:B100="Sales"), 3, -1)'
        }
    ]
};

var curCat     = 'lookup';
var curFormula = null;

function initFormulas() {
    renderCatBar();
    renderFormulaList();
}

function renderCatBar() {
    var bar = el('cat-bar');
    bar.innerHTML = '';
    CATEGORIES.forEach(function(cat) {
        var btn = document.createElement('button');
        btn.className = 'cat-btn' + (cat.id === curCat ? ' active' : '');
        btn.textContent = cat.label;
        btn.onclick = function() {
            curCat = cat.id;
            curFormula = null;
            renderCatBar();
            renderFormulaList();
            el('formula-builder').innerHTML = '<p class="empty-hint">Select a formula on the left to get started.</p>';
        };
        bar.appendChild(btn);
    });
}

function renderFormulaList() {
    var list = el('formula-list');
    list.innerHTML = '';
    (FORMULAS[curCat] || []).forEach(function(f) {
        var card = document.createElement('div');
        card.className = 'formula-card' + (curFormula && curFormula.name === f.name ? ' active' : '');
        card.innerHTML = '<div class="f-name">' + escHtml(f.name) + '</div><div class="f-desc">' + escHtml(f.desc) + '</div>';
        card.onclick = function() {
            curFormula = f;
            renderFormulaList();
            renderFormulaBuilder(f);
        };
        list.appendChild(card);
    });
}

function renderFormulaBuilder(f) {
    var b = el('formula-builder');
    var html = '<h3>' + escHtml(f.name) + '</h3><p class="f-long-desc">' + escHtml(f.desc) + '</p>';
    f.params.forEach(function(p) {
        html += '<div class="param-row"><label for="fp-' + p.id + '">' + escHtml(p.label) + '</label>';
        if (p.type === 'select') {
            html += '<select id="fp-' + p.id + '">';
            p.opts.forEach(function(o) { html += '<option>' + escHtml(o) + '</option>'; });
            html += '</select>';
        } else {
            html += '<input type="text" id="fp-' + p.id + '" placeholder="' + escHtml(p.ph) + '">';
        }
        if (p.hint) { html += '<span class="param-hint">' + escHtml(p.hint) + '</span>'; }
        html += '</div>';
    });
    html += '<div class="formula-preview" id="f-preview"></div>';
    if (f.tip) { html += '<div class="formula-tip"><strong>Tip:</strong> ' + escHtml(f.tip) + '</div>'; }
    html += '<button data-action="copyFormula">Copy Formula</button>';
    b.innerHTML = html;
    refreshPreview();
}

function buildFormula() {
    if (!curFormula) { return ''; }
    var result = curFormula.tpl;
    curFormula.params.forEach(function(p) {
        var field = el('fp-' + p.id);
        var val = field ? (field.value.trim() || p.ph) : p.ph;
        result = result.split('{' + p.id + '}').join(val);
    });
    return result;
}

function refreshPreview() {
    var preview = el('f-preview');
    if (preview) { preview.textContent = buildFormula(); }
}

function copyFormula() {
    var formula = buildFormula();
    if (!formula) { return; }
    navigator.clipboard.writeText(formula).then(function() {
        vscode.postMessage({ command: 'copySuccess', text: 'Copied: ' + formula });
    });
}

/* ── Shared utilities ───────────────────────────── */
function showStatus(id, msg, ok) {
    var box = el(id);
    box.textContent = msg;
    box.className = 'status-box ' + (ok ? 'success' : 'error');
    box.classList.remove('hidden');
}
function hideStatus(id) { el(id).classList.add('hidden'); }

/* ── Init ─────────────────────────────────────── */
ACTIONS.convertPreview  = convertPreview;
ACTIONS.convertAndCopy  = convertAndCopy;
ACTIONS.doCountValues   = doCountValues;
ACTIONS.doDedup         = doDedup;
ACTIONS.copyAnalyze     = copyAnalyze;
ACTIONS.doCompare       = doCompare;
ACTIONS.copyCompare     = copyCompare;
ACTIONS.generateSQL     = generateSQL;
ACTIONS.copySQL         = copySQL;
ACTIONS.openSqlInEditor = openSqlInEditor;
ACTIONS.copyFormula     = copyFormula;

/* Compare mode toggle. Separate from the ACTIONS table because these carry a
   value rather than naming a function. */
document.querySelectorAll('.mode-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        setCompareMode(btn.getAttribute('data-cmpmode'));
    });
});

/* Keep the key picker in step with whatever has been pasted, so the suggested
   key is ready before Compare is pressed. */
['compareColA', 'compareColB'].forEach(function(id) {
    el(id).addEventListener('input', function() {
        if (cmpMode === 'rows') { refreshKeyOptions(); }
    });
});

/* Formula parameter fields are rebuilt on every selection, so listen on the
   container instead of binding each field. */
var builderEl = el('formula-builder');
builderEl.addEventListener('input', refreshPreview);
builderEl.addEventListener('change', refreshPreview);

initFormulas();

/* Tell the extension the webview is live so it can flush queued messages. */
vscode.postMessage({ command: 'ready' });
