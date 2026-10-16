import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MCP_ACCESS_ID = "mcp-access#superuser";
export const hashMcpKey = key => createHash("sha256").update(key).digest("hex");
export function newMcpKey(ownerEmail) {
  const key = `tmax_mcp_${randomBytes(32).toString("base64url")}`;
  return { key, record: { id: MCP_ACCESS_ID, ownerEmail, keyHash: hashMcpKey(key), createdAt: new Date().toISOString() } };
}

export async function createMcpAccessStore(env = process.env) {
  const kind = env.TMUX_MOBILE_MCP_STORE || env.TMUX_MOBILE_SNIPPETS_STORE || "file";
  if (["dynamo", "dynamodb"].includes(kind)) {
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const { DynamoDBDocumentClient, GetCommand, PutCommand } = await import("@aws-sdk/lib-dynamodb");
    const table = env.TMUX_MOBILE_SNIPPETS_DYNAMO_TABLE || env.TMUX_MOBILE_USER_PREFS_DYNAMO_TABLE;
    if (!table) throw new Error("MCP access requires the user preferences DynamoDB table");
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.TMUX_MOBILE_USER_PREFS_DYNAMO_REGION || env.TMUX_MOBILE_SNIPPETS_DYNAMO_REGION || env.AWS_REGION || "us-east-1" }));
    return {
      read: async () => (await client.send(new GetCommand({ TableName: table, Key: { id: MCP_ACCESS_ID }, ConsistentRead: true }))).Item || null,
      write: async (record, { replace = false } = {}) => client.send(new PutCommand({
        TableName: table, Item: record,
        ...(!replace ? { ConditionExpression: "attribute_not_exists(id)" } : {}),
      })),
    };
  }
  if (kind !== "file") throw new Error(`Unsupported MCP access store: ${kind}`);
  const target = env.TMUX_MOBILE_MCP_CONFIG || path.join(os.homedir(), ".config", "tmux-mobile", "mcp-access.json");
  return {
    async read() {
      try { return JSON.parse(await readFile(target, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
    async write(record, { replace = false } = {}) {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const text = JSON.stringify(record) + "\n";
      if (!replace) return writeFile(target, text, { mode: 0o600, flag: "wx" });
      const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temp, text, { mode: 0o600 });
      await rename(temp, target);
    },
  };
}

export function createMcpAuthenticator({ store, superAdmins, now = Date.now, cacheMs = 30_000 }) {
  let cached = null, expires = 0, pending = null;
  return async authorization => {
    const match = /^Bearer (tmax_mcp_[A-Za-z0-9_-]{43})$/i.exec(authorization || "");
    if (!match) return null;
    if (now() >= expires) {
      pending ||= store.read().then(record => {
        cached = record;
        expires = now() + cacheMs;
      }).finally(() => { pending = null; });
      await pending;
    }
    const owner = String(cached?.ownerEmail || "").trim().toLowerCase();
    if (!cached || cached.revoked || !superAdmins.includes(owner) || !/^[a-f0-9]{64}$/.test(cached.keyHash || "")) return null;
    if (!timingSafeEqual(Buffer.from(hashMcpKey(match[1]), "hex"), Buffer.from(cached.keyHash, "hex"))) return null;
    return { userId: owner, email: owner, hd: "" };
  };
}
