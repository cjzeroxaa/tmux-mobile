import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
await build({ entryPoints: ['src/viewer.ts'], outfile: 'public/app.js', bundle: true, format: 'esm', minify: true });
await copyFile('node_modules/@xterm/xterm/css/xterm.css', 'public/xterm.css');
