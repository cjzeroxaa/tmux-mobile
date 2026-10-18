#!/usr/bin/env node
// Generation-side client. No dependencies; existing Connector login stays local.
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const args = process.argv.slice(2),
  command = args.shift();
function option(name) {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? "" : args[i + 1] || "";
}
try {
  if (!["publish", "comments", "context"].includes(command))
    throw new Error(
      "Usage: publish --kind claude|codex|pi --session ID --file page.html, or comments --id ID. Optional: --api URL",
    );
  const api = new URL(option("api") || "https://eng.xyznot.com").origin;
  if (
    !api.startsWith("https://") &&
    !["http://127.0.0.1", "http://localhost"].some(
      (x) => api === x || api.startsWith(x + ":"),
    )
  )
    throw new Error("Use HTTPS for a remote Host");
  const identityOrigin =
    api === "https://eng.xyznot.com" ? "https://eng.impo.ai" : api;
  const configPath =
    process.env.TMUX_MOBILE_AGENT_CONFIG ||
    path.join(os.homedir(), ".config/tmux-mobile/agent.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const entry = config.controllers?.[identityOrigin];
  if (!entry?.token || !entry?.agentId)
    throw new Error(
      "This machine needs a Connector login for the selected Host",
    );
  const headers = {
    authorization: `Bearer ${entry.token}`,
    "x-agent-id": entry.agentId,
  };
  let body, receipt, receiptPath;
  if (command === "publish") {
    const file = path.resolve(option("file"));
    if (!option("file")) throw new Error("--file is required");
    body = await readFile(file);
    if (body.length > 5 * 1024 * 1024) throw new Error("HTML exceeds 5 MB");
    receiptPath = `${file}.draft.json`;
    try {
      receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const kind = option("kind"),
      sessionId = option("session"),
      filename = path.basename(file);
    if (
      receipt &&
      ((receipt.api === "https://eng.xyznot.com"
        ? "https://eng.impo.ai"
        : receipt.api) !== identityOrigin ||
        receipt.kind !== kind ||
        receipt.sessionId !== sessionId)
    )
      throw new Error(
        "This receipt belongs to a different Host or session; use a different filename",
      );
    headers["content-type"] = "text/html";
    headers["x-draft-metadata"] = Buffer.from(
      JSON.stringify({
        kind,
        sessionId,
        filename,
        sourcePath: file,
        expectedVersion: option("version")
          ? Number(option("version"))
          : receipt?.version || 0,
      }),
    ).toString("base64url");
    receipt = { api, kind, sessionId };
  }
  const url = new URL("/agent/drafts", api);
  if (command === "comments") url.searchParams.set("id", option("id"));
  if (command === "context") {
    url.searchParams.set("context", "1");
    if (process.env.TMUX_PANE)
      url.searchParams.set("paneId", process.env.TMUX_PANE);
  }
  const response = await fetch(url, {
    method: command === "publish" ? "POST" : "GET",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error?.message ||
        result.error ||
        `Host returned ${response.status}`,
    );
  if (command === "publish") {
    await writeFile(
      receiptPath,
      JSON.stringify({ ...receipt, ...result }, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
