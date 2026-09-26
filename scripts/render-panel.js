#!/usr/bin/env node
/**
 * Render the Data Toolkit panel as a standalone HTML page for browser testing.
 *
 *   npm run compile-tests && node esbuild.js
 *   node scripts/render-panel.js [output.html]
 *
 * The real panel is built by ListToCSVWebviewProvider inside VS Code and loads
 * dist/webview.js through asWebviewUri. This stubs the vscode module, builds
 * the same HTML, and inlines the bundle — keeping the page's nonce, so the
 * Content-Security-Policy is exercised exactly as it is in the editor — and
 * replaces acquireVsCodeApi with a shim that records posted messages on
 * window.__posted.
 *
 * What it does NOT prove: that VS Code actually fetches dist/webview.js through
 * asWebviewUri. Only opening the panel in the Extension Development Host (F5)
 * covers that.
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, 'out', 'panel.html'));

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    return request === 'vscode' ? 'vscode-stub' : originalResolve.call(this, request, ...args);
};
require.cache['vscode-stub'] = {
    id: 'vscode-stub',
    filename: 'vscode-stub',
    loaded: true,
    exports: {
        Uri: { joinPath: (_base, ...parts) => ({ toString: () => parts.join('/') }) },
        ViewColumn: { One: 1 },
        window: {},
        commands: {},
        workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
        env: {}
    }
};

const providerPath = path.join(root, 'out', 'listToCSVWebviewProvider.js');
const bundlePath = path.join(root, 'dist', 'webview.js');
for (const [file, hint] of [[providerPath, 'npm run compile-tests'], [bundlePath, 'node esbuild.js']]) {
    if (!fs.existsSync(file)) {
        console.error(`${path.relative(root, file)} is missing — run \`${hint}\` first.`);
        process.exit(1);
    }
}

const { ListToCSVWebviewProvider } = require(providerPath);
const provider = new ListToCSVWebviewProvider({ extensionUri: {}, subscriptions: [] });
const fakeWebview = { cspSource: "'self'", asWebviewUri: uri => uri.toString() };
let html = provider._getWebviewContent(fakeWebview);

const shim = `var acquireVsCodeApi = function () {
    return { postMessage: function (m) { (window.__posted = window.__posted || []).push(m); } };
};\n`;
const bundle = fs.readFileSync(bundlePath, 'utf8');

const tag = /<script nonce="([^"]*)" src="[^"]*"><\/script>/;
if (!tag.test(html)) {
    console.error('Could not find the panel <script src> tag — has the provider markup changed?');
    process.exit(1);
}
html = html.replace(tag, (_match, nonce) => `<script nonce="${nonce}">\n${shim}${bundle}\n</script>`);

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, html);
console.log(`wrote ${path.relative(root, output)} (${html.length} bytes)`);
console.log(`inline event handlers: ${(html.match(/\son(click|input|change)=/g) || []).length}`);
