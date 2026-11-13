// Standalone build script for electron-chrome-extensions (no parent monorepo required)
import { build } from 'esbuild'
import { createRequire } from 'module'
import { mkdirSync } from 'fs'

const require = createRequire(import.meta.url)
const pkg = require('./package.json')

// External packages that should not be bundled
const external = [
  'electron',
  'debug',
  ...Object.keys(pkg.dependencies || {}),
  'peersky-chrome-extensions/preload',
]

mkdirSync('dist/cjs', { recursive: true })
mkdirSync('dist/esm', { recursive: true })

// Main CJS bundle (for require())
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/cjs/index.js',
  platform: 'node',
  format: 'cjs',
  bundle: true,
  external,
  sourcemap: true,
})

// Main ESM bundle (for import)
// Inject __dirname/__filename polyfills since ESM doesn't define them natively
const esmBanner = `
import { fileURLToPath as __fileURLToPath__ } from 'url';
import { dirname as __dirname_fn__ } from 'path';
const __filename = __fileURLToPath__(import.meta.url);
const __dirname = __dirname_fn__(__filename);
`
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/esm/index.mjs',
  platform: 'node',
  format: 'esm',
  bundle: true,
  external,
  sourcemap: true,
  banner: { js: esmBanner },
})

// Preload script (browser context)
await build({
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/chrome-extension-api.preload.js',
  platform: 'browser',
  format: 'iife',
  bundle: true,
  external: ['electron'],
  sourcemap: false,
  // For the browser, esbuild takes NODE_ENV as "development" unless told,
  // which logged every chrome.* call with its arguments and result to the
  // extension's console.
  define: { 'process.env.NODE_ENV': '"production"' },
})

// Browser-action CJS
await build({
  entryPoints: ['src/browser-action.ts'],
  outfile: 'dist/cjs/browser-action.js',
  platform: 'browser',
  format: 'cjs',
  bundle: true,
  external: ['electron'],
  sourcemap: false,
  define: { 'process.env.NODE_ENV': '"production"' },
})

// Browser-action ESM
await build({
  entryPoints: ['src/browser-action.ts'],
  outfile: 'dist/esm/browser-action.mjs',
  platform: 'browser',
  format: 'esm',
  bundle: true,
  external: ['electron'],
  sourcemap: false,
})

console.log('Build complete!')
