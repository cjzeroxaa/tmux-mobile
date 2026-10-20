#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
for (const skill of ['tmax-drafts', 'tmax-start-agent', 'tmax-config-agent']) {
  const root = new URL(`../public/skills/${skill}/`, import.meta.url);
  const files = {};
  async function walk(relative = '') {
    for (const entry of (await readdir(new URL(relative, root), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = relative + entry.name;
      if (entry.isDirectory()) await walk(name + '/');
      else if (name !== 'manifest.json') files[name] = createHash('sha256').update(await readFile(new URL(name, root))).digest('hex');
    }
  }
  await walk();
  const manifest = { name: skill, files };
  const body = JSON.stringify(manifest, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(new URL('manifest.json', root), 'utf8') !== body) throw new Error('Skill manifest is stale; run npm run build:skills');
  } else await writeFile(new URL('manifest.json', root), body);
  console.log(`${skill}: ${Object.keys(files).length} source files verified at ${fileURLToPath(root)}`);
}
