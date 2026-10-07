/* eslint-disable no-console */
// Bundles both the extension host code and the webview UI with esbuild.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node16',
  sourcemap: false,
  minify: true,
};

const webviewConfig = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: false,
  minify: true,
};

async function build() {
  fs.mkdirSync('dist', { recursive: true });
  if (watch) {
    const ctx1 = await esbuild.context(extensionConfig);
    const ctx2 = await esbuild.context(webviewConfig);
    await Promise.all([ctx1.watch(), ctx2.watch()]);
    console.log('[esbuild] watching extension + webview...');
  } else {
    await esbuild.build(extensionConfig);
    await esbuild.build(webviewConfig);
    console.log('[esbuild] built dist/extension.js + dist/webview.js');
  }
  // Webview CSS is served as a separate local resource (see CSP in provider).
  fs.copyFileSync(
    path.join('src', 'webview', 'styles.css'),
    path.join('dist', 'webview.css')
  );
  console.log('[esbuild] copied src/webview/styles.css -> dist/webview.css');
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
