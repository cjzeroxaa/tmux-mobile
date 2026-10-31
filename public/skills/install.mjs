#!/usr/bin/env node
// Install the repository-owned T-MAX Skills for Codex, Claude Code and Pi.
import { readFile, writeFile, mkdir, lstat, rename, rm, mkdtemp, cp, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const hash = value => createHash('sha256').update(value).digest('hex');
export const supportedSkills = ['tmax-drafts', 'tmax-start-agent', 'tmax-config-agent', 'tmax-assign-task', 'tmax-multi-agent'];
export async function installSkills({ source, skill = 'tmax-drafts', api = 'https://eng.xyznot.com', verify = false, env = process.env, home = os.homedir() } = {}) {
  if (!supportedSkills.includes(skill)) throw new Error('Unknown Skill: ' + skill);
  const base = new URL(`/skills/${skill}/`, api);
  async function read(name) {
    if (source) return readFile(path.join(source, name));
    const response = await fetch(new URL(name, base), { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw new Error(`Skill download failed: ${name} (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
  const manifest = JSON.parse(await read('manifest.json'));
  if (manifest.name !== skill || !manifest.files?.['SKILL.md']) throw new Error('Invalid Skill manifest');
  const entries = Object.entries(manifest.files);
  if (entries.length > 100) throw new Error('Oversized Skill manifest');
  const contents = new Map();
  // Validate every file before touching any agent installation.
  for (const [name, expected] of entries) {
    if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(name) || name.split('/').some(x => x === '.' || x === '..') || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid Skill file entry');
    const bytes = await read(name);
    if (hash(bytes) !== expected) throw new Error(`Skill checksum mismatch: ${name}`);
    contents.set(name, bytes);
  }
  const expand = value => path.resolve(value.startsWith('~/') ? path.join(home, value.slice(2)) : value);
  const roots = {
    codex: expand(env.CODEX_HOME || path.join(home, '.codex')),
    claude: expand(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')),
    pi: expand(env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent')),
  };
  const results = [];
  for (const [agent, root] of Object.entries(roots)) {
    const directory = path.join(root, 'skills', manifest.name);
    let existing;
    try { existing = await lstat(directory); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error(`Refusing to replace non-directory: ${directory}`);
    let matches = !!existing;
    for (const [name, expected] of entries) {
      try { if (hash(await readFile(path.join(directory, name))) !== expected) matches = false; }
      catch (e) { if (e.code !== 'ENOENT') throw e; matches = false; }
    }
    if (!matches && verify) throw new Error(`Installed Skill differs: ${directory}`);
    if (!matches) {
      if (existing && !new RegExp('^name: ' + skill + '\\s*$', 'm').test(await readFile(path.join(directory, 'SKILL.md'), 'utf8'))) throw new Error(`Refusing to overwrite unrelated Skill: ${directory}`);
      await mkdir(path.dirname(directory), { recursive: true });
      const temporary = await mkdtemp(path.join(path.dirname(directory), '.' + skill + '-'));
      const backup = temporary + '-previous';
      let moved = false;
      try {
        // Preserve any user-added files in this Skill directory.
        if (existing) await cp(directory, temporary, { recursive: true });
        for (const [name, bytes] of contents) {
          const target = path.join(temporary, name);
          let parent = temporary;
          for (const part of name.split('/').slice(0, -1)) {
            parent = path.join(parent, part);
            try { if ((await lstat(parent)).isSymbolicLink()) throw new Error(`Refusing Skill directory symlink: ${name}`); }
            catch (e) { if (e.code !== 'ENOENT') throw e; }
          }
          await mkdir(path.dirname(target), { recursive: true });
          // Replace a copied symlink, never write through it.
          await rm(target, { force: true });
          await writeFile(target, bytes);
        }
        if (existing) { await rename(directory, backup); moved = true; }
        try { await rename(temporary, directory); }
        catch (e) { if (moved) await rename(backup, directory); throw e; }
        if (moved) await rm(backup, { recursive: true });
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    for (const [name, expected] of entries) if (hash(await readFile(path.join(directory, name))) !== expected) throw new Error(`Verification failed: ${directory}/${name}`);
    results.push({ agent, directory, status: matches ? 'verified' : 'installed', files: entries.length });
  }
  return { skill: manifest.name, sha256: hash(JSON.stringify(manifest.files)), installations: results };
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    while (args.length) {
      const key = args.shift();
      if (key === '--verify') options.verify = true;
      else if ((key === '--source' || key === '--api' || key === '--skill') && args[0]) options[key.slice(2)] = args.shift();
      else throw new Error('Usage: node install.mjs [--api https://eng.xyznot.com | --source DIRECTORY] [--skill tmax-drafts|tmax-start-agent|tmax-config-agent|tmax-assign-task|tmax-multi-agent|all] [--verify]');
    }
    if (options.skill === 'all' || (!options.skill && !options.source)) {
      if (options.source) throw new Error('--source requires one explicit Skill, not all');
      const skills = [];
      for (const skill of supportedSkills) skills.push(await installSkills({ ...options, skill }));
      console.log(JSON.stringify({ skills }, null, 2));
    } else console.log(JSON.stringify(await installSkills(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
