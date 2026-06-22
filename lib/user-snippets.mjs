import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_SNIPPETS = Object.freeze([
  Object.freeze({ text: "yes" }),
  Object.freeze({ text: "continue" }),
  Object.freeze({ text: "/clear" }),
  Object.freeze({ text: "/btw " }),
  Object.freeze({ text: "claude" }),
  Object.freeze({ text: "codex" }),
  Object.freeze({ text: "/goal " }),
]);

const DEFAULT_USER = "default";
const MAX_SNIPPETS = 100;
const MAX_SNIPPET_CHARS = 2000;

function err(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function userKey(userId) {
  return String(userId || DEFAULT_USER).trim().toLowerCase() || DEFAULT_USER;
}

function recordId(userId) {
  return `snippets#${userKey(userId)}`;
}

export function sanitizeSnippetItems(items, { strict = false } = {}) {
  if (!Array.isArray(items)) {
    if (strict) throw err(400, "snippets.items must be an array");
    return DEFAULT_SNIPPETS.map((item) => ({ ...item }));
  }
  const clean = [];
  for (const item of items.slice(0, MAX_SNIPPETS)) {
    const raw = typeof item === "string" ? item : item?.text;
    if (typeof raw !== "string") {
      if (strict) throw err(400, "Each snippet must have a text string");
      continue;
    }
    const text = raw.slice(0, MAX_SNIPPET_CHARS);
    if (!text.trim()) continue;
    clean.push({ text });
  }
  return clean;
}

function sanitizeRecord(userId, record) {
  if (!record || typeof record !== "object") return null;
  const id = userKey(record.userId || userId);
  return {
    id: recordId(id),
    type: "user-snippets",
    userId: id,
    items: sanitizeSnippetItems(record.items),
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
  };
}

function makeRecord(userId, items, now = Date.now()) {
  const id = userKey(userId);
  return {
    id: recordId(id),
    type: "user-snippets",
    userId: id,
    items: sanitizeSnippetItems(items, { strict: true }),
    updatedAt: now,
  };
}

function createMemoryStore() {
  const byUser = new Map();
  return {
    kind: "memory",
    async load() {},
    async get(userId) {
      return byUser.get(userKey(userId)) || null;
    },
    async put(record) {
      const clean = sanitizeRecord(record.userId, record);
      if (clean) byUser.set(clean.userId, clean);
    },
    async delete(userId) {
      byUser.delete(userKey(userId));
    },
  };
}

function filePath(env) {
  return (
    env.TMUX_MOBILE_SNIPPETS_CONFIG ||
    path.join(os.homedir(), ".config", "tmux-mobile", "snippets.json")
  );
}

function createFileStore(env) {
  const target = filePath(env);
  const byUser = new Map();
  let loaded = false;

  function hydrate() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(target, "utf8") || "{}");
      const users = parsed?.byUser;
      if (users && typeof users === "object") {
        for (const [userId, record] of Object.entries(users)) {
          const clean = sanitizeRecord(userId, record);
          if (clean) byUser.set(clean.userId, clean);
        }
      }
    } catch {
      // Missing/corrupt config starts empty; defaults are synthesized on read.
    }
  }

  function flush() {
    const byUserObject = {};
    for (const [userId, record] of byUser) byUserObject[userId] = record;
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, `${JSON.stringify({ byUser: byUserObject }, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  return {
    kind: "file",
    async load() {
      hydrate();
    },
    async get(userId) {
      hydrate();
      return byUser.get(userKey(userId)) || null;
    },
    async put(record) {
      hydrate();
      const clean = sanitizeRecord(record.userId, record);
      if (clean) byUser.set(clean.userId, clean);
      flush();
    },
    async delete(userId) {
      hydrate();
      byUser.delete(userKey(userId));
      flush();
    },
  };
}

async function createDynamoStore(env) {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } = await import(
    "@aws-sdk/lib-dynamodb"
  );
  const table = env.TMUX_MOBILE_SNIPPETS_DYNAMO_TABLE || env.TMUX_MOBILE_USER_PREFS_DYNAMO_TABLE;
  if (!table) {
    throw new Error(
      "TMUX_MOBILE_USER_PREFS_DYNAMO_TABLE or TMUX_MOBILE_SNIPPETS_DYNAMO_TABLE is required for the dynamo snippets store",
    );
  }
  const region =
    env.TMUX_MOBILE_SNIPPETS_DYNAMO_REGION ||
    env.TMUX_MOBILE_USER_PREFS_DYNAMO_REGION ||
    env.AWS_REGION ||
    "us-east-1";
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return {
    kind: "dynamo",
    async load() {},
    async get(userId) {
      const res = await client.send(
        new GetCommand({ TableName: table, Key: { id: recordId(userId) } }),
      );
      return sanitizeRecord(userId, res.Item) || null;
    },
    async put(record) {
      const clean = sanitizeRecord(record.userId, record);
      if (!clean) return;
      await client.send(new PutCommand({ TableName: table, Item: clean }));
    },
    async delete(userId) {
      await client.send(new DeleteCommand({ TableName: table, Key: { id: recordId(userId) } }));
    },
  };
}

export async function createSnippetStore(env = process.env) {
  const kind = String(env.TMUX_MOBILE_SNIPPETS_STORE || "file").toLowerCase();
  if (kind === "memory") return createMemoryStore();
  if (kind === "file") return createFileStore(env);
  if (kind === "dynamo" || kind === "dynamodb") return createDynamoStore(env);
  throw new Error(
    `Unknown TMUX_MOBILE_SNIPPETS_STORE: ${kind} (expected memory | file | dynamo)`,
  );
}

export function createMemorySnippetStore() {
  return createMemoryStore();
}

export function createFileSnippetStore(env = process.env) {
  return createFileStore(env);
}

export async function describeUserSnippets(store, userId) {
  const record = await store.get(userId);
  const customized = Boolean(record);
  const items = customized
    ? sanitizeSnippetItems(record.items)
    : DEFAULT_SNIPPETS.map((item) => ({ ...item }));
  return {
    items,
    defaults: DEFAULT_SNIPPETS.map((item) => ({ ...item })),
    customized,
    store: store.kind,
    updatedAt: customized ? record.updatedAt || 0 : 0,
  };
}

export async function updateUserSnippets(store, userId, items, { now = Date.now } = {}) {
  const record = makeRecord(userId, items, now());
  await store.put(record);
  return describeUserSnippets(store, userId);
}

export async function resetUserSnippets(store, userId) {
  await store.delete(userId);
  return describeUserSnippets(store, userId);
}
