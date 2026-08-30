const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/** Extension host bundle — Node, CommonJS, vscode provided by the runtime. */
const extensionConfig = {
	entryPoints: [
		'src/extension.ts'
	],
	bundle: true,
	format: 'cjs',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'node',
	outfile: 'dist/extension.js',
	external: ['vscode'],
	logLevel: 'silent',
	plugins: [
		/* add to the end of plugins array */
		esbuildProblemMatcherPlugin,
	],
};

/**
 * Panel bundle — browser, IIFE, loaded through asWebviewUri.
 *
 * Building this separately is what lets the panel `import` from src/utils
 * instead of carrying hand-written copies of the same helpers.
 */
const webviewConfig = {
	entryPoints: [
		'src/webview/main.ts'
	],
	bundle: true,
	format: 'iife',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'browser',
	target: 'es2020',
	outfile: 'dist/webview.js',
	logLevel: 'silent',
	plugins: [esbuildProblemMatcherPlugin],
};

async function main() {
	const contexts = await Promise.all([
		esbuild.context(extensionConfig),
		esbuild.context(webviewConfig),
	]);

	if (watch) {
		await Promise.all(contexts.map(ctx => ctx.watch()));
	} else {
		await Promise.all(contexts.map(ctx => ctx.rebuild()));
		await Promise.all(contexts.map(ctx => ctx.dispose()));
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
