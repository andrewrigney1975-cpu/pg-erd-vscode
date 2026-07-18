// Build script: bundles the extension host (Node) and the webview (browser) separately,
// since they run in different environments and only the webview bundle may touch the DOM.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const distDir = path.join(__dirname, 'dist');
const webviewDistDir = path.join(distDir, 'webview');

function copyStaticAssets() {
  fs.mkdirSync(webviewDistDir, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, 'webview', 'style.css'),
    path.join(webviewDistDir, 'style.css')
  );
}

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const webviewConfig = {
  entryPoints: ['webview/main.ts'],
  bundle: true,
  outfile: 'dist/webview/main.js',
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

async function run() {
  copyStaticAssets();

  if (watch) {
    const [extCtx, webCtx] = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webviewConfig),
    ]);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log('[esbuild] watching for changes...');

    fs.watchFile(path.join(__dirname, 'webview', 'style.css'), { interval: 500 }, () => {
      copyStaticAssets();
      console.log('[esbuild] copied webview/style.css');
    });
  } else {
    await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
