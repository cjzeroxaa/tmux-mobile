import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_USER = "default";
const MAX_CARD_STARS = 1000;
const MAX_CARD_STAR_KEY_CHARS = 500;

function err(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function userKey(userId) {
  return String(userId || DEFAULT_USER).trim().toLowerCase() || DEFAULT_USER;
}

function recordId(userId) {
  return `card-stars#${userKey(userId)}`;
}

export function sanitizeCardStarKeys(keys, { strict = false } = {}) {
  if (!Array.isArray(keys)) {
    if (strict) throw err(400, "cardStars.keys must be an array");
    return [];
  }
  const clean = [];
  const seen = new Set();
  for (const key of keys.slice(0, MAX_CARD_STARS)) {
    if (typeof key !== "string") {
      if (strict) throw err(400, "Each card star key must be a string");
      continue;
    }
    const value = key.slice(0, MAX_CARD_STAR_KEY_CHARS);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    clean.push(value);
  }
  return clean;
}

function sanitizeRecord(userId, record) {
  if (!record || typeof record !== "object") return null;
  const id = userKey(record.userId || userId);
  return {
    id: recordId(id),
    type: "user-card-stars",
    userId: id,
    keys: sanitizeCardStarKeys(record.keys),
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
  };
}

function makeRecord(userId, keys, now = Date.now()) {
  const id = userKey(userId);
  return {
    id: recordId(id),
    type: "user-card-stars",
    userId: id,
    keys: sanitizeCardStarKeys(keys, { strict: true }),
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
    env.TMUX_MOBILE_CARD_STARS_CONFIG ||
    path.join(os.homedir(), ".config", "tmux-mobile", "card-stars.json")
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
      // Missing/corrupt config starts empty.
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
  const table =
    env.TMUX_MOBILE_CARD_STARS_DYNAMO_TABLE ||
    env.TMUX_MOBILE_USER_PREFS_DYNAMO_TABLE ||
    env.TMUX_MOBILE_SNIPPETS_DYNAMO_TABLE;
  if (!table) {
    throw new Error(
      "TMUX_MOBILE_USER_PREFS_DYNAMO_TABLE or TMUX_MOBILE_CARD_STARS_DYNAMO_TABLE is required for the dynamo card-stars store",
    );
  }
  const region =
    env.TMUX_MOBILE_CARD_STARS_DYNAMO_REGION ||
    env.TMUX_MOBILE_USER_PREFS_DYNAMO_REGION ||
    env.TMUX_MOBILE_SNIPPETS_DYNAMO_REGION ||
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

export async function createCardStarStore(env = process.env) {
  const kind = String(
    env.TMUX_MOBILE_CARD_STARS_STORE ||
      env.TMUX_MOBILE_SNIPPETS_STORE ||
      (env.TMUX_MOBILE_USER_PREFS_DYNAMO_TABLE ? "dynamo" : "file"),
  ).toLowerCase();
  if (kind === "memory") return createMemoryStore();
  if (kind === "file") return createFileStore(env);
  if (kind === "dynamo" || kind === "dynamodb") return createDynamoStore(env);
  throw new Error(
    `Unknown TMUX_MOBILE_CARD_STARS_STORE: ${kind} (expected memory | file | dynamo)`,
  );
}

export function createMemoryCardStarStore() {
  return createMemoryStore();
}

export function createFileCardStarStore(env = process.env) {
  return createFileStore(env);
}

export async function describeUserCardStars(store, userId) {
  const record = await store.get(userId);
  const customized = Boolean(record);
  return {
    keys: customized ? sanitizeCardStarKeys(record.keys) : [],
    customized,
    store: store.kind,
    updatedAt: customized ? record.updatedAt || 0 : 0,
  };
}

export async function updateUserCardStars(store, userId, keys, { now = Date.now } = {}) {
  const record = makeRecord(userId, keys, now());
  await store.put(record);
  return describeUserCardStars(store, userId);
}

export async function resetUserCardStars(store, userId) {
  await store.delete(userId);
  return describeUserCardStars(store, userId);
}
