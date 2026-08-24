import * as vscode from 'vscode';
import { getNonce } from './utils/htmlUtils';
import { openSqlInEditor } from './utils/editorUtils';

export class ListToCSVWebviewProvider {
    public static readonly viewType = 'list-to-csv.webview';
    private _panel: vscode.WebviewPanel | undefined;
    private readonly _extensionUri: vscode.Uri;

    /** Set once the webview script has loaded and reported in. */
    private _ready = false;

    /** Messages posted before the webview was ready, replayed on 'ready'. */
    private _pending: object[] = [];

    constructor(private readonly context: vscode.ExtensionContext) {
        this._extensionUri = context.extensionUri;
    }

    /**
     * Reveal the toolkit panel.
     * @param options.prefillInput Copy the active selection into the Convert
     * tab. Callers targeting another tab pass false.
     */
    public show(options: { prefillInput?: boolean } = {}) {
        const { prefillInput = true } = options;
        const isNewPanel = !this._panel;

        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
        } else {
            this._ready = false;
            this._pending = [];

            this._panel = vscode.window.createWebviewPanel(
                ListToCSVWebviewProvider.viewType,
                'Data Toolkit',
                vscode.ViewColumn.One,
                { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this._extensionUri] }
            );

            this._panel.webview.html = this._getWebviewContent();

            this._panel.webview.onDidReceiveMessage(
                message => {
                    switch (message.command) {
                        case 'ready':
                            this._ready = true;
                            for (const queued of this._pending) {
                                this._panel?.webview.postMessage(queued);
                            }
                            this._pending = [];
                            return;
                        case 'convertAndCopy':
                            vscode.window.showInformationMessage('Converted and copied ' + message.count + ' records to clipboard!');
                            return;
                        case 'sqlGenerated':
                            vscode.window.showInformationMessage('SQL for ' + String(message.dialect).toUpperCase() + ' copied to clipboard!');
                            return;
                        case 'copySuccess':
                            vscode.window.showInformationMessage(message.text);
                            return;
                        case 'openInEditor':
                            openSqlInEditor(String(message.text ?? ''));
                            return;
                        case 'error':
                            vscode.window.showErrorMessage(message.text);
                            return;
                    }
                },
                null,
                this.context.subscriptions
            );

            this._panel.onDidDispose(() => {
                this._panel = undefined;
                this._ready = false;
                this._pending = [];
            }, null, this.context.subscriptions);
        }

        if (prefillInput) {
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.selection.isEmpty) {
                // Only overwrite the Convert input on a fresh panel; revealing an
                // already-open panel must not discard what the user typed there.
                this.sendMessage({
                    command: 'setContent',
                    content: editor.document.getText(editor.selection),
                    replace: isNewPanel
                });
            }
        }
    }

    /**
     * Post a message to the webview, queueing it if the webview has not
     * finished loading yet.
     */
    public sendMessage(message: object) {
        if (!this._panel) {
            return;
        }
        if (this._ready) {
            this._panel.webview.postMessage(message);
        } else {
            this._pending.push(message);
        }
    }

    private _getWebviewContent(): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Data Toolkit</title>
<style>
:root { --r: 4px; --gap: 1rem; }
* { box-sizing: border-box; }
body {
    padding: 0; margin: 0;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    background: var(--vscode-editor-background);
}
.container { padding: 16px 20px; max-width: 1000px; margin: 0 auto; }
.title {
    font-size: 1.3rem; font-weight: 500; margin: 0 0 12px;
    padding-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border);
    color: var(--vscode-titleBar-activeForeground);
}

/* ── Tab bar ─────────────────────────────────────── */
.tab-bar { display: flex; gap: 2px; margin-bottom: 16px; border-bottom: 1px solid var(--vscode-panel-border); }
.tab-btn {
    padding: 6px 14px; background: transparent; color: var(--vscode-foreground);
    border: none; border-bottom: 2px solid transparent; cursor: pointer;
    font-size: 12px; font-family: var(--vscode-font-family); opacity: .65;
}
.tab-btn:hover { opacity: 1; }
.tab-btn.active { border-bottom-color: var(--vscode-focusBorder); opacity: 1; font-weight: 500; }
.tab-content { display: none; }
.tab-content.active { display: block; }

/* ── Form elements ───────────────────────────────── */
label { display: block; margin-bottom: 4px; font-size: 12px; font-weight: 500; }
textarea, input[type="text"], select {
    width: 100%;
    border: 1px solid var(--vscode-input-border);
    border-radius: var(--r);
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
}

/* Pasted data keeps the editor font — monospace makes columns and delimiters
   line up, which is the whole point of these fields. */
textarea {
    padding: 6px 8px;
    resize: vertical;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
}

/* Configuration controls use the UI font instead. They previously inherited
   --vscode-editor-font-size, which the user controls and is commonly 15-16px,
   inside a fixed 28px box that (with border-box) left only 14px of content —
   so the text clipped. min-height cannot clip, whatever the font size. */
input[type="text"], select {
    padding: 4px 8px;
    min-height: 28px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    line-height: 1.4;
}

/* Leave room for the native dropdown chevron */
select { cursor: pointer; padding-right: 24px; }
.checkbox-row { display: flex; align-items: center; gap: 6px; margin: 6px 0; font-size: 12px; }
.checkbox-row input[type="checkbox"] { accent-color: var(--vscode-focusBorder); margin: 0; }

button {
    padding: 6px 14px; border: none; border-radius: var(--r); cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    font-size: 12px; font-family: var(--vscode-font-family);
}
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary {
    background: var(--vscode-button-secondaryBackground, var(--vscode-panel-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border);
}
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-panel-border)); }

.btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.field { margin-bottom: 10px; }
.options-row { display: flex; gap: var(--gap); flex-wrap: wrap; margin-bottom: 10px; }
.option-card {
    flex: 1 1 180px; min-width: 140px;
    background: var(--vscode-panel-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--r); padding: 10px 12px;
}
.option-card h4 { margin: 0 0 8px; font-size: 11px; font-weight: 600; text-transform: uppercase; opacity: .7; }

.output-pre {
    width: 100%; min-height: 80px; max-height: 200px; overflow: auto;
    padding: 8px; border: 1px solid var(--vscode-panel-border); border-radius: var(--r);
    background: var(--vscode-editorWidget-background);
    font-family: var(--vscode-editor-font-family); font-size: 12px;
    white-space: pre-wrap; word-break: break-all; margin-top: 8px;
}
.status-box {
    margin-top: 10px; padding: 8px 12px; border-radius: var(--r);
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-panel-background); font-size: 12px;
}
.status-box.success { border-color: var(--vscode-notificationsSuccessBorder, #4caf50); }
.status-box.error { border-color: var(--vscode-notificationsErrorBorder, #f44336); }
.hidden { display: none !important; }

/* ── Count & Dedupe tab ──────────────────────────── */
.result-meta { font-size: 11px; opacity: .7; margin-bottom: 6px; }

/* ── Compare tab ─────────────────────────────────── */
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: var(--gap); margin-bottom: 10px; }
.three-col { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--gap); margin-top: 12px; }
.result-card { border: 1px solid var(--vscode-panel-border); border-radius: var(--r); overflow: hidden; }
.result-card-head {
    padding: 7px 10px; font-size: 11px; font-weight: 600;
    display: flex; justify-content: space-between; align-items: center;
    background: var(--vscode-panel-background);
}
.card-only-a .result-card-head { border-left: 3px solid #e06c75; }
.card-common  .result-card-head { border-left: 3px solid #98c379; }
.card-only-b  .result-card-head { border-left: 3px solid #61afef; }
.result-card-count { opacity: .65; font-weight: 400; }
.result-card-body { max-height: 220px; overflow-y: auto; padding: 6px 10px; font-size: 12px; font-family: var(--vscode-editor-font-family); }
.result-item { padding: 2px 0; border-bottom: 1px solid var(--vscode-panel-border); word-break: break-all; }
.result-item:last-child { border-bottom: none; }
.result-card-foot { padding: 6px 10px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-panel-background); }
.result-card-foot button { width: 100%; }
.empty-hint { font-size: 12px; opacity: .5; font-style: italic; padding: 4px 0; }

/* ── SQL Builder tab ─────────────────────────────── */
.sql-config { display: grid; grid-template-columns: 1fr 1fr; gap: var(--gap); margin-bottom: 10px; }
.sql-output {
    width: 100%; min-height: 160px; max-height: 400px; overflow: auto; resize: vertical;
    padding: 8px; border: 1px solid var(--vscode-panel-border); border-radius: var(--r);
    background: var(--vscode-editorWidget-background);
    font-family: var(--vscode-editor-font-family); font-size: 12px;
    white-space: pre; margin-top: 8px; tab-size: 4;
}

/* ── Excel Formulas tab ──────────────────────────── */
.cat-bar { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.cat-btn {
    padding: 4px 12px; border-radius: 12px; border: 1px solid var(--vscode-panel-border);
    background: transparent; cursor: pointer; font-size: 12px;
    color: var(--vscode-foreground); font-family: var(--vscode-font-family);
}
.cat-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.formula-layout { display: grid; grid-template-columns: 220px 1fr; gap: var(--gap); }
.formula-list { display: flex; flex-direction: column; gap: 4px; }
.formula-card {
    padding: 8px 10px; border: 1px solid var(--vscode-panel-border); border-radius: var(--r);
    cursor: pointer; background: var(--vscode-panel-background);
}
.formula-card:hover, .formula-card.active { border-color: var(--vscode-focusBorder); }
.formula-card.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.formula-card.active .f-desc { color: inherit; }
.f-name { font-weight: 600; font-size: 12px; }
.f-desc { font-size: 11px; opacity: .7; margin-top: 2px; }
.formula-builder { padding: 0; }
.formula-builder h3 { margin: 0 0 4px; font-size: 14px; }
.formula-builder .f-long-desc { font-size: 12px; opacity: .75; margin-bottom: 10px; }
.param-row { margin-bottom: 8px; }
.param-hint { font-size: 11px; opacity: .6; margin-top: 2px; display: block; }
.formula-preview {
    padding: 8px 12px; background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-focusBorder); border-radius: var(--r);
    font-family: var(--vscode-editor-font-family); font-size: 13px;
    margin: 10px 0; word-break: break-all; min-height: 36px;
    color: var(--vscode-terminal-ansiGreen, #4ec9b0);
}
.formula-tip {
    font-size: 11px; padding: 6px 10px; border-radius: var(--r); margin-bottom: 10px;
    background: var(--vscode-editorInfo-background, rgba(0,122,204,.1));
    border-left: 3px solid var(--vscode-editorInfo-foreground, #007acc);
}
</style>
</head>
<body>
<div class="container">
<h1 class="title">Data Toolkit</h1>

<div class="tab-bar">
    <!-- data-tab stays "convert": it is the internal id used by switchToTab and
         the compareColumns command, and is not user-visible. -->
    <button class="tab-btn active" data-tab="convert">List &rarr; Line</button>
    <button class="tab-btn" data-tab="analyze">Count &amp; Dedupe</button>
    <button class="tab-btn" data-tab="compare">Compare Columns</button>
    <button class="tab-btn" data-tab="sql">SQL Builder</button>
    <button class="tab-btn" data-tab="excel">Excel Formulas</button>
</div>

<!-- ═══ TAB 1: CONVERT ═══════════════════════════════════════ -->
<div id="tab-convert" class="tab-content active">
    <div class="field">
        <label for="listInput">Input (one item per line):</label>
        <textarea id="listInput" rows="8" placeholder="Paste your list here..."></textarea>
    </div>
    <div class="options-row">
        <div class="option-card">
            <h4>Separator</h4>
            <input type="text" id="separator" value="," style="width:80px">
        </div>
        <div class="option-card">
            <h4>Enclosure</h4>
            <div class="checkbox-row"><input type="radio" name="enc" id="encNone" value=""><label for="encNone">None</label></div>
            <div class="checkbox-row"><input type="radio" name="enc" id="encSingle" value="'" checked><label for="encSingle">Single quotes</label></div>
            <div class="checkbox-row"><input type="radio" name="enc" id="encDouble" value='"'><label for="encDouble">Double quotes</label></div>
        </div>
        <div class="option-card">
            <h4>Format</h4>
            <div class="checkbox-row"><input type="checkbox" id="sqlIn"><label for="sqlIn">Wrap as SQL IN&nbsp;( )</label></div>
            <div class="checkbox-row"><input type="checkbox" id="convertDedup"><label for="convertDedup">Remove duplicates</label></div>
        </div>
    </div>
    <div class="btn-row">
        <button data-action="convertPreview">Preview</button>
        <button data-action="convertAndCopy">Convert &amp; Copy</button>
    </div>
    <div id="convertPreviewBox" class="output-pre hidden"></div>
    <div id="convertStatus" class="status-box hidden"></div>
</div>

<!-- ═══ TAB 2: COUNT & DEDUPE ════════════════════════════════ -->
<div id="tab-analyze" class="tab-content">
    <div class="field">
        <label for="analyzeInput">Values (one per line):</label>
        <textarea id="analyzeInput" rows="8" placeholder="Paste values here..."></textarea>
    </div>
    <div class="options-row">
        <div class="option-card">
            <h4>Options</h4>
            <div class="checkbox-row"><input type="checkbox" id="analyzeCaseSensitive" checked><label for="analyzeCaseSensitive">Case-sensitive</label></div>
            <div class="checkbox-row"><input type="checkbox" id="analyzeTrim" checked><label for="analyzeTrim">Trim whitespace</label></div>
        </div>
        <div class="option-card">
            <h4>Count Output</h4>
            <div class="checkbox-row"><input type="radio" name="countFmt" id="fmtCsv" value="csv" checked><label for="fmtCsv">CSV (value,count)</label></div>
            <div class="checkbox-row"><input type="radio" name="countFmt" id="fmtTab" value="tab"><label for="fmtTab">TSV (value[tab]count)</label></div>
        </div>
    </div>
    <div class="btn-row">
        <button data-action="doCountValues">Count Values</button>
        <button class="secondary" data-action="doDedup">Remove Duplicates</button>
    </div>
    <div id="analyzeResult" class="hidden">
        <p class="result-meta" id="analyzeMeta"></p>
        <div id="analyzeOutput" class="output-pre"></div>
        <div class="btn-row" style="margin-top:6px">
            <button data-action="copyAnalyze">Copy to Clipboard</button>
        </div>
    </div>
    <div id="analyzeStatus" class="status-box hidden"></div>
</div>

<!-- ═══ TAB 3: COMPARE COLUMNS ══════════════════════════════ -->
<div id="tab-compare" class="tab-content">
    <div class="two-col">
        <div class="field">
            <label for="compareColA">Column A:</label>
            <textarea id="compareColA" rows="9" placeholder="Paste values (one per line)..."></textarea>
        </div>
        <div class="field">
            <label for="compareColB">Column B:</label>
            <textarea id="compareColB" rows="9" placeholder="Paste values (one per line)..."></textarea>
        </div>
    </div>
    <div class="options-row">
        <div class="option-card">
            <h4>Options</h4>
            <div class="checkbox-row"><input type="checkbox" id="cmpCase" checked><label for="cmpCase">Case-sensitive</label></div>
            <div class="checkbox-row"><input type="checkbox" id="cmpTrim" checked><label for="cmpTrim">Trim whitespace</label></div>
        </div>
    </div>
    <div class="btn-row">
        <button data-action="doCompare">Compare</button>
    </div>
    <div id="compareResults" class="three-col hidden">
        <div class="result-card card-only-a">
            <div class="result-card-head"><span>Only in A</span><span class="result-card-count" id="cntA">0</span></div>
            <div class="result-card-body" id="listA"><span class="empty-hint">—</span></div>
            <div class="result-card-foot"><button data-action="copyCompare" data-arg="A">Copy</button></div>
        </div>
        <div class="result-card card-common">
            <div class="result-card-head"><span>In Both</span><span class="result-card-count" id="cntCommon">0</span></div>
            <div class="result-card-body" id="listCommon"><span class="empty-hint">—</span></div>
            <div class="result-card-foot"><button data-action="copyCompare" data-arg="common">Copy</button></div>
        </div>
        <div class="result-card card-only-b">
            <div class="result-card-head"><span>Only in B</span><span class="result-card-count" id="cntB">0</span></div>
            <div class="result-card-body" id="listB"><span class="empty-hint">—</span></div>
            <div class="result-card-foot"><button data-action="copyCompare" data-arg="B">Copy</button></div>
        </div>
    </div>
</div>

<!-- ═══ TAB 4: SQL BUILDER ══════════════════════════════════ -->
<div id="tab-sql" class="tab-content">
    <div class="field">
        <label for="sqlInput">Paste tabular data (CSV, TSV, pipe-delimited, or space-aligned):</label>
        <textarea id="sqlInput" rows="8" placeholder="Paste your data here. First row can be column headers."></textarea>
    </div>
    <div class="sql-config">
        <div class="field"><label for="sqlTable">Table Name:</label><input type="text" id="sqlTable" value="my_table"></div>
        <div class="field">
            <label for="sqlDialect">Dialect:</label>
            <select id="sqlDialect">
                <option value="spark">Spark SQL</option>
                <option value="mssql">MS SQL Server</option>
                <option value="mysql">MySQL</option>
                <option value="postgres">PostgreSQL</option>
            </select>
        </div>
    </div>
    <div class="options-row">
        <div class="option-card">
            <h4>Data</h4>
            <div class="checkbox-row"><input type="checkbox" id="sqlHeaders" checked><label for="sqlHeaders">First row is headers</label></div>
            <div class="checkbox-row"><input type="checkbox" id="sqlInferTypes" checked><label for="sqlInferTypes">Auto-detect column types</label></div>
            <div class="checkbox-row"><input type="checkbox" id="sqlSizeVarchar"><label for="sqlSizeVarchar" title="Off: VARCHAR(255). On: sized to the widest pasted value — tighter, but can truncate data outside the sample.">Size VARCHAR to sample</label></div>
            <div class="checkbox-row"><input type="checkbox" id="sqlAlwaysQuote"><label for="sqlAlwaysQuote" title="Off: only names that need it are quoted. On: every table and column name is quoted.">Always quote identifiers</label></div>
        </div>
        <div class="option-card">
            <h4>Generate</h4>
            <div class="checkbox-row"><input type="checkbox" id="sqlGenCreate" checked><label for="sqlGenCreate">CREATE TABLE</label></div>
            <div class="checkbox-row"><input type="checkbox" id="sqlGenInsert" checked><label for="sqlGenInsert">INSERT statements</label></div>
        </div>
    </div>
    <div class="btn-row">
        <button data-action="generateSQL">Generate SQL</button>
        <button class="secondary" data-action="copySQL">Copy SQL</button>
        <button class="secondary" data-action="openSqlInEditor">Open in Editor</button>
    </div>
    <div id="sqlOutput" class="sql-output hidden"></div>
    <div id="sqlStatus" class="status-box hidden"></div>
</div>

<!-- ═══ TAB 5: EXCEL FORMULAS ═══════════════════════════════ -->
<div id="tab-excel" class="tab-content">
    <div id="cat-bar" class="cat-bar"></div>
    <div class="formula-layout">
        <div id="formula-list" class="formula-list"></div>
        <div id="formula-builder" class="formula-builder">
            <p class="empty-hint">Select a formula on the left to get started.</p>
        </div>
    </div>
</div>

</div><!-- /container -->

<script nonce="${nonce}">
var vscode = acquireVsCodeApi();

/* ── Event delegation ────────────────────────────── */
/* The Content-Security-Policy above blocks inline handlers, so buttons declare
   a data-action and are dispatched through this table. It also covers markup
   rendered later (the formula builder) without rebinding. */
var ACTIONS = {};

document.addEventListener('click', function(e) {
    var el = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!el) { return; }
    var fn = ACTIONS[el.getAttribute('data-action')];
    if (fn) { fn(el.getAttribute('data-arg')); }
});

/* ── Tab switching ───────────────────────────────── */
document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        var tab = btn.getAttribute('data-tab');
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
        btn.classList.add('active');
        document.getElementById('tab-' + tab).classList.add('active');
    });
});

function switchToTab(name) {
    var btn = document.querySelector('.tab-btn[data-tab="' + name + '"]');
    if (btn) { btn.click(); }
}

/* ── Message handler ─────────────────────────────── */
window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.command) {
        case 'setContent':
            /* Never clobber text the user already has in the Convert tab. */
            var input = document.getElementById('listInput');
            if (msg.replace !== false || !input.value.trim()) { input.value = msg.content; }
            break;
        case 'switchToTab':
            switchToTab(msg.tab);
            break;
        case 'setCompareColumnA':
            document.getElementById('compareColA').value = msg.content;
            break;
    }
});

/* ═══ TAB 1: CONVERT ════════════════════════════════════════ */
function getConvertLines() {
    /* Split on CRLF as well as LF — a stray \\r would otherwise end up inside
       the quotes when the list was pasted from a Windows file. */
    var lines = document.getElementById('listInput').value
        .split(/\\r?\\n/)
        .map(function(l) { return l.trim(); })
        .filter(function(l) { return l !== ''; });
    if (document.getElementById('convertDedup').checked) {
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
    var sep = document.getElementById('separator').value || ',';
    var enc = document.querySelector('input[name="enc"]:checked').value;
    var sqlIn = document.getElementById('sqlIn').checked;
    /* Double any quote character inside the value, otherwise a value such as
       O'Brien closes the literal early and produces a broken IN clause. */
    var formatted = lines.map(function(l) {
        return enc ? enc + l.split(enc).join(enc + enc) + enc : l;
    }).join(sep);
    return sqlIn ? 'IN (' + formatted + ')' : formatted;
}

function convertPreview() {
    var result = getConvertResult();
    if (!result) { showStatus('convertStatus', 'Please enter some values.', false); return; }
    var box = document.getElementById('convertPreviewBox');
    box.textContent = result;
    box.classList.remove('hidden');
    hideStatus('convertStatus');
}

function convertAndCopy() {
    var result = getConvertResult();
    if (!result) { showStatus('convertStatus', 'Please enter some values.', false); return; }
    var count = getConvertLines().length;
    navigator.clipboard.writeText(result).then(function() {
        var box = document.getElementById('convertPreviewBox');
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
    var text = document.getElementById('analyzeInput').value;
    var trim = document.getElementById('analyzeTrim').checked;
    var cs = document.getElementById('analyzeCaseSensitive').checked;
    var lines = text.split(/\\r?\\n/).filter(function(l) { return l.trim() !== ''; });
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
    var isCsv = document.getElementById('fmtCsv').checked;
    var delim = isCsv ? ',' : '\\t';
    var header = isCsv ? 'value,count' : 'value\\tcount';
    var rows = sorted.map(function(v) {
        var cell = isCsv && (v.indexOf(',') !== -1 || v.indexOf('"') !== -1) ? '"' + v.replace(/"/g, '""') + '"' : v;
        return cell + delim + counts[v];
    });
    analyzeLastResult = header + '\\n' + rows.join('\\n');
    document.getElementById('analyzeMeta').textContent = sorted.length + ' unique values from ' + lines.length + ' total. Top: ' + sorted.slice(0, 3).join(', ');
    document.getElementById('analyzeOutput').textContent = analyzeLastResult;
    document.getElementById('analyzeResult').classList.remove('hidden');
    hideStatus('analyzeStatus');
}

function doDedup() {
    var lines = getAnalyzeLines();
    if (!lines.length) { showStatus('analyzeStatus', 'No values found.', false); return; }
    var seen = {};
    var unique = [];
    lines.forEach(function(l) { if (!seen[l]) { seen[l] = true; unique.push(l); } });
    var removed = lines.length - unique.length;
    analyzeLastResult = unique.join('\\n');
    document.getElementById('analyzeMeta').textContent = unique.length + ' unique values (' + removed + ' duplicates removed)';
    document.getElementById('analyzeOutput').textContent = analyzeLastResult;
    document.getElementById('analyzeResult').classList.remove('hidden');
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

function doCompare() {
    var cs = document.getElementById('cmpCase').checked;
    var trim = document.getElementById('cmpTrim').checked;

    function parseCol(id) {
        var lines = document.getElementById(id).value.split(/\\r?\\n/).filter(function(l) { return l.trim() !== ''; });
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
    document.getElementById('compareResults').classList.remove('hidden');
}

function renderCompareList(listId, cntId, items) {
    document.getElementById(cntId).textContent = items.length + ' item' + (items.length !== 1 ? 's' : '');
    var el = document.getElementById(listId);
    if (!items.length) {
        el.innerHTML = '<span class="empty-hint">None</span>';
    } else {
        el.innerHTML = items.map(function(v) {
            return '<div class="result-item">' + escHtml(v) + '</div>';
        }).join('');
    }
}

function copyCompare(key) {
    var items = compareData[key];
    if (!items || !items.length) { return; }
    navigator.clipboard.writeText(items.join('\\n')).then(function() {
        vscode.postMessage({ command: 'copySuccess', text: 'Copied ' + items.length + ' items to clipboard!' });
    });
}

/* ═══ TAB 4: SQL BUILDER ════════════════════════════════════ */
function detectSep(line) {
    if (!line) { return null; }
    if (line.indexOf('\\t') !== -1) { return '\\t'; }
    if (line.indexOf(',') !== -1) { return ','; }
    if (line.indexOf('|') !== -1) { return '|'; }
    /* Runs of two or more spaces — a fixed '  ' would mis-split columns
       padded to different widths. */
    if (/\\s{2,}/.test(line)) { return /\\s{2,}/; }
    return null;
}

function getDefaultType(dialect) {
    return dialect === 'spark' ? 'STRING' : 'VARCHAR(255)';
}

var DATE_RX = /^\\d{4}[-\\/]\\d{1,2}[-\\/]\\d{1,2}$/;
var TS_RX   = /^\\d{4}[-\\/]\\d{1,2}[-\\/]\\d{1,2}[T ]\\d{1,2}:\\d{1,2}/;

/* Decimal integers and decimals only. Number() would also accept '0x1F',
   '1e5', 'Infinity' and '00123' — writing the last of those unquoted turns a
   zero-padded id into 123 and silently loses data. */
var PLAIN_NUMBER_RX = /^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?$/;

function isPlainNumber(v) {
    return PLAIN_NUMBER_RX.test(String(v).trim());
}

function inferType(vals, dialect, sizeFromSample) {
    if (!vals.length) { return getDefaultType(dialect); }
    var allInt = true, allNum = true, maxLen = 0;
    var allDate = vals.every(function(v) { return DATE_RX.test(v); });
    var allTs   = vals.every(function(v) { return TS_RX.test(v); });
    vals.forEach(function(v) {
        maxLen = Math.max(maxLen, v.length);
        if (!isPlainNumber(v)) { allInt = false; allNum = false; }
        else if (!Number.isInteger(Number(v))) { allInt = false; }
    });
    /* Only size from the sample when asked, matching inferSqlDataType in
       src/utils/sqlUtils.ts. A paste is usually a subset of the real data. */
    var varcharSize = sizeFromSample
        ? Math.min(255, Math.max(10, Math.ceil(maxLen * 1.5 / 10) * 10))
        : 255;

    switch (dialect) {
        case 'mssql':
            if (allTs)   { return 'DATETIME'; }
            if (allDate) { return 'DATE'; }
            if (allInt)  { return 'INT'; }
            if (allNum)  { return 'FLOAT'; }
            return maxLen <= 255 ? 'VARCHAR(' + varcharSize + ')' : 'TEXT';
        case 'mysql':
            if (allTs)   { return 'DATETIME'; }
            if (allDate) { return 'DATE'; }
            if (allInt)  { return 'INT'; }
            if (allNum)  { return 'FLOAT'; }
            return maxLen <= 255 ? 'VARCHAR(' + varcharSize + ')' : 'TEXT';
        case 'postgres':
            if (allTs)   { return 'TIMESTAMP'; }
            if (allDate) { return 'DATE'; }
            if (allInt)  { return 'INTEGER'; }
            if (allNum)  { return 'DECIMAL'; }
            return maxLen <= 255 ? 'VARCHAR(' + varcharSize + ')' : 'TEXT';
        case 'spark':
            if (allTs)   { return 'TIMESTAMP'; }
            if (allDate) { return 'DATE'; }
            if (allInt)  { return 'INT'; }
            if (allNum)  { return 'DOUBLE'; }
            return 'STRING';
    }
    return getDefaultType(dialect);
}

function fmtSqlVal(v, infer) {
    if (!v || v.trim() === '') { return 'NULL'; }
    if (infer) {
        if (isPlainNumber(v)) { return v; }
        if (DATE_RX.test(v) || TS_RX.test(v)) { return "'" + v + "'"; }
    }
    return "'" + v.replace(/'/g, "''") + "'";
}

/* Mirrors needsQuoting / quoteIdentifier in src/utils/sqlUtils.ts. */
var PLAIN_IDENTIFIER_RX = /^[A-Za-z_][A-Za-z0-9_]*$/;
var RESERVED_WORDS = new Set([
    'add','all','alter','and','any','as','asc','begin','between','by','case',
    'cast','check','column','commit','constraint','create','cross','current',
    'database','default','delete','desc','distinct','drop','else','end','except',
    'exists','external','false','for','foreign','from','full','function','grant',
    'group','having','if','in','index','inner','insert','intersect','interval',
    'into','is','join','key','left','like','limit','merge','natural','not',
    'null','offset','on','or','order','outer','over','partition','primary',
    'procedure','range','references','rename','replace','right','rollback','row',
    'rows','schema','select','set','show','some','table','temporary','then','to',
    'top','transaction','trigger','true','union','unique','update','use','user',
    'using','values','view','when','where','window','with'
]);

function needsQuoting(name) {
    return !PLAIN_IDENTIFIER_RX.test(name) || RESERVED_WORDS.has(String(name).toLowerCase());
}

/* Quoting a plain name like my_table is unnecessary, and downstream tools do
   not always strip the quotes again — the name can end up carrying them. */
function quoteId(name, dialect, always) {
    if (!always && !needsQuoting(name)) { return name; }
    switch (dialect) {
        case 'mssql':    return '[' + String(name).replace(/]/g, ']]') + ']';
        case 'postgres': return '"' + String(name).replace(/"/g, '""') + '"';
        /* mysql and spark both delimit with backticks */
        default:         return '\`' + String(name).replace(/\`/g, '\`\`') + '\`';
    }
}

/* Split one delimited line honouring RFC 4180 quoting, so a field such as
   "Smith, John" stays a single column. Mirrors parseDelimitedLine in
   src/utils/sqlUtils.ts. */
function parseDelimitedLine(line, sep) {
    if (sep instanceof RegExp || sep.length !== 1) {
        return line.split(sep).map(function(f) { return f.trim(); });
    }
    var fields = [], field = '', inQuotes = false;
    for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') { field += '"'; i++; }
                else { inQuotes = false; }
            } else { field += ch; }
        } else if (ch === '"' && field.trim() === '') {
            inQuotes = true; field = '';
        } else if (ch === sep) {
            fields.push(field.trim()); field = '';
        } else { field += ch; }
    }
    fields.push(field.trim());
    return fields;
}

/* Valid, unique SQL identifiers. Mirrors sanitizeColumnNames in sqlUtils.ts. */
function sanitizeColumnNames(headers) {
    var seen = Object.create(null);
    return headers.map(function(header, index) {
        var name = String(header == null ? '' : header)
            .trim()
            .replace(/[^a-zA-Z0-9_]+/g, '_')
            .replace(/^_+|_+$/g, '');
        if (!name) { name = 'column' + (index + 1); }
        if (/^\\d/.test(name)) { name = 'col_' + name; }
        var key = name.toLowerCase();
        var count = seen[key] || 0;
        seen[key] = count + 1;
        return count === 0 ? name : name + '_' + (count + 1);
    });
}

function generateSQL() {
    var raw = document.getElementById('sqlInput').value;
    var lines = raw.split(/\\r?\\n/).filter(function(l) { return l.trim() !== ''; });
    if (!lines.length) { showStatus('sqlStatus', 'No data found.', false); return; }

    var dialect  = document.getElementById('sqlDialect').value;
    var hasHdr   = document.getElementById('sqlHeaders').checked;
    var infer    = document.getElementById('sqlInferTypes').checked;
    var genCre   = document.getElementById('sqlGenCreate').checked;
    var genIns   = document.getElementById('sqlGenInsert').checked;
    var sizeVar  = document.getElementById('sqlSizeVarchar').checked;
    var alwaysQ  = document.getElementById('sqlAlwaysQuote').checked;

    /* Read alwaysQ before quoting: with var hoisting, computing tbl above this
       point silently saw undefined and ignored the setting. */
    var tblRaw   = document.getElementById('sqlTable').value.trim() || 'my_table';
    var tbl      = quoteId(tblRaw, dialect, alwaysQ);

    var sep = detectSep(lines[0]);
    var headers, dataRows;

    if (sep) {
        var rows = lines.map(function(l) { return parseDelimitedLine(l, sep); });
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
        sql += 'CREATE TABLE ' + tbl + ' (\\n';
        headers.forEach(function(h, i) {
            var colVals = dataRows.map(function(r) { return i < r.length ? r[i] : ''; }).filter(function(v) { return v !== ''; });
            var type = infer ? inferType(colVals, dialect, sizeVar) : getDefaultType(dialect);
            sql += '    ' + quoteId(h, dialect, alwaysQ) + ' ' + type;
            sql += i < headers.length - 1 ? ',\\n' : '\\n';
        });
        sql += ')';
        if (dialect === 'spark') { sql += '\\nUSING DELTA'; }
        if (dialect === 'mysql') { sql += '\\nENGINE=InnoDB DEFAULT CHARSET=utf8mb4'; }
        /* Terminate for every dialect, not just postgres — an unterminated
           CREATE TABLE fails once the script is run as multiple statements. */
        sql += ';\\n';
    }

    if (genIns && dataRows.length) {
        var colList = headers.map(function(h) { return quoteId(h, dialect, alwaysQ); }).join(', ');
        sql += '\\nINSERT INTO ' + tbl + ' (' + colList + ') VALUES\\n';
        sql += dataRows.map(function(row) {
            var vals = headers.map(function(_, ci) {
                return fmtSqlVal(ci < row.length ? row[ci] : '', infer);
            });
            return '    (' + vals.join(', ') + ')';
        }).join(',\\n');
        sql += ';\\n';
    }

    var out = document.getElementById('sqlOutput');
    out.textContent = sql;
    out.classList.remove('hidden');
    hideStatus('sqlStatus');
    vscode.postMessage({ command: 'sqlGenerated', dialect: dialect });
}

function currentSql() {
    var text = document.getElementById('sqlOutput').textContent;
    if (!text) {
        generateSQL();
        text = document.getElementById('sqlOutput').textContent;
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
    var bar = document.getElementById('cat-bar');
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
            document.getElementById('formula-builder').innerHTML = '<p class="empty-hint">Select a formula on the left to get started.</p>';
        };
        bar.appendChild(btn);
    });
}

function renderFormulaList() {
    var list = document.getElementById('formula-list');
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
    var b = document.getElementById('formula-builder');
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
        var el = document.getElementById('fp-' + p.id);
        var val = el ? (el.value.trim() || p.ph) : p.ph;
        result = result.split('{' + p.id + '}').join(val);
    });
    return result;
}

function refreshPreview() {
    var el = document.getElementById('f-preview');
    if (el) { el.textContent = buildFormula(); }
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
    var el = document.getElementById(id);
    el.textContent = msg;
    el.className = 'status-box ' + (ok ? 'success' : 'error');
    el.classList.remove('hidden');
}
function hideStatus(id) { document.getElementById(id).classList.add('hidden'); }
function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

/* Formula parameter fields are rebuilt on every selection, so listen on the
   container instead of binding each field. */
var builderEl = document.getElementById('formula-builder');
builderEl.addEventListener('input', refreshPreview);
builderEl.addEventListener('change', refreshPreview);

initFormulas();

/* Tell the extension the webview is live so it can flush queued messages. */
vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
    }
}
