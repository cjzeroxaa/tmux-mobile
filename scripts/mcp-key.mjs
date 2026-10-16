#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createMcpAccessStore, newMcpKey } from "../lib/mcp-access.mjs";

const { values } = parseArgs({ options: {
  owner: { type: "string" }, output: { type: "string" }, rotate: { type: "boolean", default: false },
} });
if (!values.output) throw new Error("Use --output /private/path/tmax-mcp.json (the key is never printed)");
const access = JSON.parse(await readFile(new URL("../config/access-control.json", import.meta.url), "utf8"));
const owner = (values.owner || access.superAdminEmails[0] || "").trim().toLowerCase();
if (!access.superAdminEmails.includes(owner)) throw new Error("Owner must be a configured super administrator");
const store = await createMcpAccessStore();
if (await store.read() && !values.rotate) throw new Error("An MCP key already exists. Use --rotate only to replace it.");
const { key, record } = newMcpKey(owner);
// Refuse to overwrite a local credential file. Save the only plaintext copy
// before updating the database so an output failure cannot lose the new key.
await writeFile(values.output, JSON.stringify({ mcpServers: { tmax: {
  type: "http", url: "https://eng.xyznot.com/mcp", headers: { Authorization: `Bearer ${key}` },
} } }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
await store.write(record, { replace: values.rotate });
console.log(`MCP credential saved to ${values.output}; database stores only its SHA-256 hash.`);
