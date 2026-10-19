import { spawnSync } from 'node:child_process';
// Publishing versions leaves the already provisioned custom domain untouched.
// Unlike `wrangler deploy`, this does not require Zone Workers Routes permissions.
const upload = spawnSync('npx', ['wrangler', 'versions', 'upload'], { encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
process.stdout.write(upload.stdout || '');
process.stderr.write(upload.stderr || '');
if (upload.status !== 0) process.exit(upload.status || 1);
const id = upload.stdout.match(/(?:Version ID|Worker Version ID):\s*([0-9a-f-]{36})/i)?.[1];
if (!id) throw Error('Could not find uploaded Worker version; nothing deployed');
const deploy = spawnSync('npx', ['wrangler', 'versions', 'deploy', `${id}@100%`, '--yes'], { stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
process.exit(deploy.status || 0);
