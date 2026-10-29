import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHmac } from "node:crypto";
import { machineAssetPrefix, ASSET_ORIGIN, assetSigningKey } from '../lib/draft-assets.mjs';
import { validToken } from '../services/draft-assets/worker.mjs';
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
const exec = promisify(execFile),
  temp = await mkdtemp(path.join(os.tmpdir(), "draft-http-"));
const socket = net.createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const api = `http://127.0.0.1:${port}`,
  secret = "draft-test-only-secret",
  email = "draft-test@example.com";
const token = (type, userId = email) => {
  const body = Buffer.from(
    JSON.stringify({
      type,
      userId,
      email: userId,
      hd: "",
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  ).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
};
const cookie = `tmux_mobile_session=${token("session")}`,
  agentId = "ad18a714-1fc7-4185-aede-e0a85c647001";
let output = "";
const child = spawn(process.execPath, ["server.mjs", "--controller"], {
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    TMUX_MOBILE_ACCESS_CONTROL_FILE: new URL("./fixtures/multi-user-access.json", import.meta.url).pathname,
    SESSION_SECRET: secret,
    GOOGLE_OAUTH_CLIENT_ID: "test",
    GOOGLE_OAUTH_CLIENT_SECRET: "test",
    GOOGLE_DEVICE_CLIENT_ID: "test",
    GOOGLE_DEVICE_CLIENT_SECRET: "test",
    OPENAI_API_KEY: "test",
    ALLOW_ALL_GOOGLE_USERS: "1",
    TMUX_MOBILE_DRAFTS_CONFIG: path.join(temp, "index.json"),
    TMUX_MOBILE_ARTIFACT_DIR: path.join(temp, "bytes"),
    TMUX_MOBILE_ARTIFACT_STORAGE: "local",
    TMUX_MOBILE_COMMENT_INDEX: "memory",
    TMUX_MOBILE_PIN_INDEX: "memory",
    TMUX_MOBILE_TRANSCRIPT_ARCHIVE_ENABLED: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (output += d));
const call = async (url, opts = {}) => {
  const r = await fetch(api + url, {
    ...opts,
    headers: { cookie, "content-type": "application/json", ...opts.headers },
  });
  return { status: r.status, body: await r.json() };
};
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready = (await fetch(api + "/api/health")).ok;
      if (ready) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, output);
  assert.equal((await fetch(api + "/api/drafts")).status, 401);
  assert.equal((await fetch(api + "/agent/drafts")).status, 401);
  assert.equal((await fetch(api + "/draft-client.mjs")).status, 200);
  assert.equal((await fetch(api + "/skills/tmax-drafts/SKILL.md")).status, 200);
  assert.equal((await fetch(api + "/skills/install.mjs")).status, 200);
  assert.equal((await fetch(api + "/skills/tmax-drafts/manifest.json")).status, 200);
  for (const file of ["SKILL.md", "manifest.json", "scripts/create-session.py"]) {
    assert.equal((await fetch(api + "/skills/tmax-start-agent/" + file)).status, 200);
  }
  for (const file of ["SKILL.md", "manifest.json"]) {
    assert.equal((await fetch(api + "/skills/tmax-config-agent/" + file)).status, 200);
    assert.equal((await fetch(api + "/skills/tmax-assign-task/" + file)).status, 200);
  }
  const skills = JSON.parse((await exec(process.execPath, ["public/skills/install.mjs", "--api", api], {
    env: { ...process.env, CODEX_HOME: path.join(temp, 'codex'), CLAUDE_CONFIG_DIR: path.join(temp, 'claude'), PI_CODING_AGENT_DIR: path.join(temp, 'pi') },
  })).stdout);
  assert.deepEqual(skills.skills.map(x => x.skill), ['tmax-drafts', 'tmax-start-agent', 'tmax-config-agent', 'tmax-assign-task']);
  assert.ok(skills.skills.every(x => x.installations.length === 3));
  const config = path.join(temp, "agent.json");
  await writeFile(
    config,
    JSON.stringify({
      controllers: { [api]: { token: token("agent"), agentId } },
    }),
  );
  const file = path.join(temp, "review.html");
  await writeFile(
    file,
    "<!doctype html><html><head><title>Private review</title></head><body><p>Full selected explanation.</p></body></html>",
  );
  const client = async (...args) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          ["public/draft-client.mjs", ...args, "--api", api],
          {
            env: { ...process.env, TMUX_MOBILE_AGENT_CONFIG: config },
            timeout: 15000,
          },
        )
      ).stdout,
    );
  const context = await client("context");
  assert.ok(context.machineId.startsWith("m:"));
  assert.deepEqual(context.sessions, []);
  const first = await client(
    "publish",
    "--kind",
    "codex",
    "--session",
    "test-session",
    "--file",
    file,
  );
  assert.equal(first.version, 1);
  const retry = await client(
    "publish",
    "--kind",
    "codex",
    "--session",
    "test-session",
    "--file",
    file,
  );
  assert.equal(retry.version, 1);
  const list = await call("/api/drafts");
  assert.equal(list.body.drafts.length, 1);
  const stranger = await call(`/api/drafts?id=${first.id}`, {
    headers: {
      cookie: `tmux_mobile_session=${token("session", "other@example.org")}`,
    },
  });
  assert.equal(stranger.status, 404);
  const saved = await call(`/api/drafts/comments?id=${first.id}`, {
    method: "POST",
    body: JSON.stringify({
      version: 1,
      text: "Please explain this",
      anchor: { quote: "selected explanation", prefix: "Full ", suffix: "." },
    }),
  });
  assert.equal(saved.status, 201);
  const overall = await call(`/api/drafts/comments?id=${first.id}`, {
    method: "POST",
    body: JSON.stringify({ version: 1, text: "Simplify the whole draft", anchor: null }),
  });
  assert.equal(overall.status, 201);
  assert.equal(overall.body.comment.scope, "document");
  assert.equal(overall.body.comment.anchor, null);
  const feedback = await client("comments", "--id", first.id);
  assert.equal(feedback.comments[0].text, "Please explain this");
  assert.equal(feedback.comments[1].text, "Simplify the whole draft");
  assert.equal(feedback.comments[1].anchor, null);
  const prompt = await call(`/api/drafts/prompt?id=${first.id}`, {
    method: "POST",
    body: JSON.stringify({ send: false }),
  });
  assert.match(prompt.body.prompt, /Please explain this/);
  assert.match(prompt.body.prompt, /Overall comment \(whole draft\)/);
  assert.match(prompt.body.prompt, /Simplify the whole draft/);
  assert.ok(prompt.body.prompt.includes(file));
  assert.ok(prompt.body.prompt.includes(`--file '${file}'`));
  const sent = await call(`/api/drafts/prompt?id=${first.id}`, {
    method: "POST",
    body: JSON.stringify({ send: true }),
  });
  assert.equal(sent.status, 409);
  await writeFile(
    file,
    "<!doctype html><html><head><title>Private review</title></head><body><p>Revised full explanation.</p></body></html>",
  );
  const next = await client(
    "publish",
    "--kind",
    "codex",
    "--session",
    "test-session",
    "--file",
    file,
  );
  assert.equal(next.id, first.id);
  assert.equal(next.version, 2);
  const historical = await fetch(
    `${api}/api/drafts/content?id=${first.id}&version=1`,
    { headers: { cookie } },
  );
  assert.equal(historical.status, 200);
  assert.match(await historical.text(), /Full selected explanation/);
  assert.match(
    historical.headers.get("content-security-policy"),
    /sandbox allow-scripts/,
  );
  const assetUrl = ASSET_ORIGIN + '/' + machineAssetPrefix(context.machineId) + 'a'.repeat(64) + '.mp4';
  await writeFile(file, `<!doctype html><html><head><title>Media review</title></head><body><p>Selectable media explanation.</p><video controls src="${assetUrl}"></video></body></html>`);
  const media = await client('publish', '--kind', 'codex', '--session', 'test-session', '--file', file);
  const rendered = await fetch(`${api}/api/drafts/content?id=${media.id}`, { headers: { cookie } });
  assert.equal(rendered.status, 200);
  assert.match(rendered.headers.get('content-security-policy'), /media-src data: blob: https:\/\/draft-assets.xyznot.com/);
  const renderedHtml = await rendered.text();
  const readUrl = new URL(renderedHtml.match(/src="(https:\/\/draft-assets[^\"]+)"/)[1]);
  assert.ok(await validToken(readUrl.pathname, readUrl.searchParams.get('token'), assetSigningKey(secret)));
  const download = await fetch(`${api}/api/drafts/content?id=${media.id}&download=1`, { headers: { cookie } });
  assert.ok(!(await download.text()).includes('?token='), 'stored/downloaded HTML contains no temporary read credentials');
  const denied = await fetch(`${api}/api/drafts/content?id=${media.id}`, { headers: { cookie: `tmux_mobile_session=${token('session', 'other@example.org')}` } });
  assert.equal(denied.status, 404);
  const sharePath = `/api/drafts/sharing?id=${media.id}`;
  assert.equal((await fetch(api + sharePath, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"enabled":true}' })).status, 401);
  assert.equal((await call(sharePath, { method: 'PUT', headers: { cookie: `tmux_mobile_session=${token('session', 'other@example.org')}` }, body: '{"enabled":true}' })).status, 404);
  for (const headers of [{ origin: 'https://other.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }]) {
    assert.equal((await call(sharePath, { method: 'PUT', headers, body: '{"enabled":true}' })).status, 403);
  }
  assert.equal((await call(`/api/drafts?id=${media.id}`)).body.sharing.enabled, false);
  const sharing = await call(sharePath, { method: 'PUT', headers: { origin: api }, body: '{"enabled":true}' });
  assert.equal(sharing.status, 200);
  const publicUrl = api + sharing.body.sharing.path;
  const anonymous = await fetch(publicUrl, { redirect: 'manual' });
  assert.equal(anonymous.status, 200, 'public Draft requires no login or redirect');
  const publicHtml = await anonymous.text();
  assert.match(publicHtml, /Selectable media explanation/);
  assert.doesNotMatch(publicHtml, /Please explain this|Simplify the whole draft|locateDraftQuote|test-session/);
  const publicMedia = new URL(publicHtml.match(/src="(https:\/\/draft-assets[^\"]+)"/)[1]);
  assert.ok(await validToken(publicMedia.pathname, publicMedia.searchParams.get('token'), assetSigningKey(secret)));
  assert.equal((await fetch(publicUrl, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(publicUrl, { method: 'PUT' })).status, 405);
  assert.equal((await fetch(`${api}/api/drafts?id=${media.id}`)).status, 401, 'public links never authorize private metadata');
  assert.equal((await fetch(`${api}/api/drafts/content?id=${media.id}`)).status, 401);
  assert.equal((await fetch(`${api}/api/drafts/comments?id=${media.id}`, { method: 'POST' })).status, 401);
  assert.equal((await call(sharePath, { method: 'PUT', body: '{"enabled":false}' })).status, 200);
  assert.equal((await fetch(publicUrl, { redirect: 'manual' })).status, 404);
  const enabledAgain = await call(sharePath, { method: 'PUT', body: '{"enabled":true}' });
  assert.notEqual(enabledAgain.body.sharing.path, sharing.body.sharing.path);
  assert.equal((await fetch(publicUrl)).status, 404);
  assert.equal((await fetch(api + enabledAgain.body.sharing.path)).status, 200);
  console.log(
    "drafts HTTP: real controller + CLI, private review, anonymous sharing/media, auth/CSRF boundaries and revocation passed",
  );
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
  await rm(temp, { recursive: true, force: true });
}
