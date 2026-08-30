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

            this._panel.webview.html = this._getWebviewContent(this._panel.webview);

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
                            // Generating renders into the panel; it does not touch
                            // the clipboard. This claimed otherwise for the whole
                            // life of the extension, so people reasonably pasted
                            // stale content believing the copy had happened.
                            vscode.window.showInformationMessage(
                                `${String(message.dialect).toUpperCase()} SQL generated — use "Copy SQL" or "Open in Editor".`
                            );
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

    private _getWebviewContent(webview: vscode.Webview): string {
        const nonce = getNonce();

        // The panel script is bundled separately by esbuild so it can import the
        // same helpers the extension host uses. It must be addressed through
        // asWebviewUri — a plain path is blocked by the webview's origin.
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js')
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
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

/* ── Row diff ────────────────────────────────────── */
.mode-bar { display: flex; gap: 6px; margin-bottom: 12px; }
.mode-btn {
    padding: 4px 12px; border-radius: 12px; border: 1px solid var(--vscode-panel-border);
    background: transparent; cursor: pointer; font-size: 12px;
    color: var(--vscode-foreground); font-family: var(--vscode-font-family);
}
.mode-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }

.diff-summary { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; margin: 12px 0 8px; }
.diff-stat { display: flex; align-items: center; gap: 5px; }
.diff-chip {
    display: inline-block; width: 16px; text-align: center; border-radius: 3px;
    font-weight: 700; font-size: 11px; line-height: 16px;
}
.chip-added    { background: rgba(152,195,121,.22); color: #98c379; }
.chip-removed  { background: rgba(224,108,117,.22); color: #e06c75; }
.chip-changed  { background: rgba(229,192,123,.22); color: #e5c07b; }
.chip-unchanged{ background: var(--vscode-panel-background); opacity: .7; }

.diff-warning {
    font-size: 11px; padding: 6px 10px; border-radius: var(--r); margin-bottom: 6px;
    background: rgba(229,192,123,.10); border-left: 3px solid #e5c07b;
}

.diff-scroll { overflow-x: auto; max-height: 420px; overflow-y: auto; border: 1px solid var(--vscode-panel-border); border-radius: var(--r); }
table.diff { border-collapse: collapse; width: 100%; font-size: 12px; font-family: var(--vscode-editor-font-family); }
table.diff th, table.diff td { padding: 4px 8px; text-align: left; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; }
table.diff th {
    position: sticky; top: 0; z-index: 1; font-family: var(--vscode-font-family);
    background: var(--vscode-panel-background); font-size: 11px; text-transform: uppercase; opacity: .75;
}
table.diff td.status { width: 1%; font-weight: 700; text-align: center; }
/* Status is carried by a glyph as well as colour, so it does not rely on colour alone. */
tr.row-added   td.status { color: #98c379; }
tr.row-removed td.status { color: #e06c75; }
tr.row-changed td.status { color: #e5c07b; }
tr.row-added   { background: rgba(152,195,121,.07); }
tr.row-removed { background: rgba(224,108,117,.07); }
tr.row-changed { background: rgba(229,192,123,.07); }
tr.row-unchanged { opacity: .55; }
td.cell-changed { background: rgba(229,192,123,.16); }
.val-before { color: #e06c75; text-decoration: line-through; opacity: .8; }
.val-arrow  { opacity: .5; margin: 0 4px; }
.val-after  { color: #98c379; }
.diff-truncated { font-size: 11px; opacity: .7; padding: 6px 10px; }
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
    <div class="mode-bar">
        <button class="mode-btn active" data-cmpmode="values">Values</button>
        <button class="mode-btn" data-cmpmode="rows">Rows (tabular)</button>
    </div>
    <div class="two-col">
        <div class="field">
            <label for="compareColA" id="labelColA">Column A:</label>
            <textarea id="compareColA" rows="9" placeholder="Paste values (one per line)..."></textarea>
        </div>
        <div class="field">
            <label for="compareColB" id="labelColB">Column B:</label>
            <textarea id="compareColB" rows="9" placeholder="Paste values (one per line)..."></textarea>
        </div>
    </div>
    <div class="options-row">
        <div class="option-card">
            <h4>Options</h4>
            <div class="checkbox-row"><input type="checkbox" id="cmpCase" checked><label for="cmpCase">Case-sensitive</label></div>
            <div class="checkbox-row"><input type="checkbox" id="cmpTrim" checked><label for="cmpTrim">Trim whitespace</label></div>
        </div>
        <div class="option-card hidden" id="cmpRowOptions">
            <h4>Match rows on</h4>
            <div class="field" style="margin-bottom:6px">
                <select id="cmpKey"><option value="">Load data to pick a key…</option></select>
            </div>
            <div class="checkbox-row"><input type="checkbox" id="cmpShowUnchanged"><label for="cmpShowUnchanged">Show unchanged rows</label></div>
        </div>
    </div>
    <div class="btn-row">
        <button data-action="doCompare">Compare</button>
    </div>
    <div id="diffWarnings"></div>
    <div id="diffSummary" class="diff-summary hidden"></div>
    <div id="diffResults" class="hidden"></div>
    <div id="compareStatus" class="status-box hidden"></div>
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

<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
