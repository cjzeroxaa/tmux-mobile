import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, cp, mkdir, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSkills } from '../public/skills/install.mjs';
const root = await mkdtemp(path.join(os.tmpdir(), 'tmax-skills-test-'));
const source = fileURLToPath(new URL('../public/skills/tmax-drafts', import.meta.url));
try {
  const linkedEntry = path.join(root, 'linked-install.mjs');
  await symlink(fileURLToPath(new URL('../public/skills/install.mjs', import.meta.url)), linkedEntry);
  const cli = await promisify(execFile)(process.execPath, [linkedEntry, '--source', source], {
    env: { ...process.env, CODEX_HOME: path.join(root, 'cli-codex'), CLAUDE_CONFIG_DIR: path.join(root, 'cli-claude'), PI_CODING_AGENT_DIR: path.join(root, 'cli-pi') },
  });
  assert.equal(JSON.parse(cli.stdout).installations.length, 3, 'CLI must run through a symlink, including macOS /tmp');
  const options = { source, home: root, env: { CODEX_HOME: path.join(root,'custom-codex'), CLAUDE_CONFIG_DIR: '~/custom-claude', PI_CODING_AGENT_DIR: '~/custom-pi' } };
  const first = await installSkills(options);
  assert.equal(first.installations.length, 3);
  assert.ok(first.installations.every(x => x.status === 'installed' && x.files === 6));
  assert.equal(first.installations[2].directory, path.join(root,'custom-pi/skills/tmax-drafts'));
  const entry = first.installations[0].directory;
  await writeFile(path.join(entry, 'personal-note.txt'), 'keep');
  const again = await installSkills(options);
  assert.ok(again.installations.every(x => x.status === 'verified'));
  await writeFile(path.join(entry,'references/pr-lens.md'), 'old');
  await assert.rejects(installSkills({ ...options, verify: true }), /differs/);
  await installSkills(options);
  assert.equal(await readFile(path.join(entry, 'personal-note.txt'), 'utf8'), 'keep');
  assert.equal((await installSkills({ ...options, verify: true })).sha256, first.sha256);
  const bad = path.join(root, 'bad-source');
  await cp(source,bad,{recursive:true});
  await writeFile(path.join(bad, 'SKILL.md'), 'corrupt');
  const freshHome = path.join(root,'untouched');
  await assert.rejects(installSkills({source:bad,home:freshHome,env:{}}),/checksum mismatch/);
  await assert.rejects(readFile(path.join(freshHome,'.codex/skills/tmax-drafts/SKILL.md')),/ENOENT/);
  const manifest = JSON.parse(await readFile(path.join(bad,'manifest.json')));
  manifest.files = { 'SKILL.md': manifest.files['SKILL.md'], '../escape': '0'.repeat(64) };
  await cp(path.join(source,'SKILL.md'),path.join(bad,'SKILL.md'));
  await writeFile(path.join(bad,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(installSkills({source:bad,home:freshHome,env:{}}), /Invalid Skill file/);
  console.log('Skill install: three agents, overrides, idempotency, repair, preserved files, checksums and path boundary passed');
} finally { await rm(root,{recursive:true,force:true}); }
