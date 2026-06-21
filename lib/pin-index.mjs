// Pluggable index for pinned-artifact METADATA records.
//
// This is deliberately separate from lib/artifact-storage.mjs (which holds the
// artifact BYTES — large, immutable, content-addressed, served via presign). The
// index holds the small mutable records (owner, name, share scope, token, …) and
// is queried by id/token/owner. Those are different access patterns, so they get
// different backends: bytes in GCS/S3/local-disk, records in Firestore (or a
// memory/file driver for the boring local default).
//
// Record-level operations (get/put/delete/all) — NOT whole-file rewrites — so
// two concurrent mutations touch different documents instead of racing on one
// blob. A pin record is a plain JSON-able object; sanitization/validation lives
// in lib/pins.mjs (it owns the record shape). The index just persists and returns
// objects, keyed by the record's `id`.
//
// Interface (all async):
//   load()            -> void          // optional warm-up; drivers may no-op
//   get(id)           -> record | null
//   all()             -> record[]      // every record (callers filter/sort)
//   put(record)       -> void          // upsert by record.id
//   delete(id)        -> void          // idempotent
//   kind              -> "memory" | "file" | "firestore"
//
// Selected by TMUX_MOBILE_PIN_INDEX: "memory" (default) | "file" | "firestore".
// The Firestore SDK is imported lazily so a local-only checkout still boots.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// memory driver (default): ephemeral, zero infra. Right for local/Tailscale
// single-process use where durability across restarts isn't expected, and the
// default in unit tests.
// ---------------------------------------------------------------------------

function createMemoryIndex() {
  const byId = new Map();
  return {
    kind: "memory",
    async load() {},
    async get(id) {
      return byId.get(String(id)) || null;
    },
    async all() {
      return [...byId.values()];
    },
    async put(record) {
      byId.set(String(record.id), record);
    },
    async delete(id) {
      byId.delete(String(id));
    },
  };
}

// ---------------------------------------------------------------------------
// file driver: the original local-disk JSON behavior, behind the record API.
// One file holds { pins: { [id]: record } }; reads are served from an in-memory
// cache hydrated on load(), writes rewrite the file (fine for a single-user box;
// for concurrent/cloud use, prefer firestore). Best-effort like voice-config:
// a write failure (read-only home) leaves the in-memory copy authoritative.
// ---------------------------------------------------------------------------

function indexFilePath(env) {
  return (
    env.TMUX_MOBILE_PINS_CONFIG ||
    path.join(os.homedir(), ".config", "tmux-mobile", "pins.json")
  );
}

function createFileIndex(env) {
  const filePath = indexFilePath(env);
  const byId = new Map();
  let loaded = false;

  function hydrate() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8") || "{}");
      const pins = parsed?.pins;
      if (pins && typeof pins === "object") {
        for (const [id, record] of Object.entries(pins)) {
          if (record && typeof record === "object") byId.set(String(id), record);
        }
      }
    } catch {
      // missing/corrupt → empty
    }
  }

  function flush() {
    const pins = {};
    for (const [id, record] of byId) pins[id] = record;
    try {
      mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      writeFileSync(filePath, `${JSON.stringify({ pins }, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // best-effort: in-memory copy stays authoritative for this process
    }
  }

  return {
    kind: "file",
    async load() {
      hydrate();
    },
    async get(id) {
      hydrate();
      return byId.get(String(id)) || null;
    },
    async all() {
      hydrate();
      return [...byId.values()];
    },
    async put(record) {
      hydrate();
      byId.set(String(record.id), record);
      flush();
    },
    async delete(id) {
      hydrate();
      byId.delete(String(id));
      flush();
    },
  };
}

// ---------------------------------------------------------------------------
// firestore driver: one document per pin in a collection, keyed by pin id.
// Per-document writes (no whole-collection rewrite), naturally concurrent-safe.
// Auth via ADC / workload identity (the Cloud Run runtime SA). Lazy import so a
// local-only deploy without the SDK still boots.
//   Env: TMUX_MOBILE_FIRESTORE_DATABASE (default "(default)"),
//        TMUX_MOBILE_PIN_COLLECTION    (default "pins").
// ---------------------------------------------------------------------------

async function createFirestoreIndex(env) {
  const { Firestore } = await import("@google-cloud/firestore");
  const databaseId = env.TMUX_MOBILE_FIRESTORE_DATABASE || "(default)";
  const collectionName = env.TMUX_MOBILE_PIN_COLLECTION || "pins";
  const firestore = new Firestore({
    ...(env.GOOGLE_CLOUD_PROJECT ? { projectId: env.GOOGLE_CLOUD_PROJECT } : {}),
    ...(databaseId && databaseId !== "(default)" ? { databaseId } : {}),
    ignoreUndefinedProperties: true,
  });
  const col = firestore.collection(collectionName);
  return {
    kind: "firestore",
    async load() {
      // No warm cache — each op queries Firestore directly. (load() exists for
      // interface symmetry; a connectivity check here would just add startup
      // latency without changing behavior.)
    },
    async get(id) {
      const snap = await col.doc(String(id)).get();
      return snap.exists ? snap.data() : null;
    },
    async all() {
      const snap = await col.get();
      return snap.docs.map((d) => d.data());
    },
    async put(record) {
      // Doc id == record.id so put is an idempotent upsert.
      await col.doc(String(record.id)).set(record);
    },
    async delete(id) {
      await col.doc(String(id)).delete();
    },
  };
}

// ---------------------------------------------------------------------------
// dynamodb driver: one item per pin in a table, partition key "id" == pin id.
// Per-item writes (no whole-table rewrite) — naturally concurrent-safe, same
// shape as the firestore driver. Use an ON-DEMAND (PAY_PER_REQUEST) table so
// there's no capacity to manage. Auth via the AWS default credential chain (the
// ECS task role). Lazy import so a deploy without the SDK still boots.
//   Env: TMUX_MOBILE_DYNAMO_TABLE  (required)
//        TMUX_MOBILE_DYNAMO_REGION (default AWS_REGION / us-east-1)
// ---------------------------------------------------------------------------

async function createDynamoIndex(env) {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, ScanCommand } =
    await import("@aws-sdk/lib-dynamodb");
  const table = env.TMUX_MOBILE_DYNAMO_TABLE;
  if (!table) {
    throw new Error("TMUX_MOBILE_DYNAMO_TABLE is required for the dynamo pin index");
  }
  const region = env.TMUX_MOBILE_DYNAMO_REGION || env.AWS_REGION || "us-east-1";
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return {
    kind: "dynamo",
    async load() {
      // No warm cache — each op hits DynamoDB directly (interface symmetry).
    },
    async get(id) {
      const res = await client.send(
        new GetCommand({ TableName: table, Key: { id: String(id) } }),
      );
      return res.Item || null;
    },
    async all() {
      const items = [];
      let ExclusiveStartKey;
      // Scan paginates at 1MB; follow LastEvaluatedKey to read the whole table.
      do {
        const res = await client.send(new ScanCommand({ TableName: table, ExclusiveStartKey }));
        if (Array.isArray(res.Items)) items.push(...res.Items);
        ExclusiveStartKey = res.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return items;
    },
    async put(record) {
      // Item key == record.id so put is an idempotent upsert.
      await client.send(
        new PutCommand({ TableName: table, Item: { ...record, id: String(record.id) } }),
      );
    },
    async delete(id) {
      await client.send(new DeleteCommand({ TableName: table, Key: { id: String(id) } }));
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// Build the pin index selected by TMUX_MOBILE_PIN_INDEX. Async because the
// firestore driver lazily imports its SDK.
export async function createPinIndex(env = process.env) {
  const kind = String(env.TMUX_MOBILE_PIN_INDEX || "memory").toLowerCase();
  if (kind === "memory") return createMemoryIndex();
  if (kind === "file") return createFileIndex(env);
  if (kind === "firestore") return createFirestoreIndex(env);
  if (kind === "dynamo" || kind === "dynamodb") return createDynamoIndex(env);
  throw new Error(
    `Unknown TMUX_MOBILE_PIN_INDEX: ${kind} (expected memory | file | firestore | dynamo)`,
  );
}

// Synchronous memory-index factory for tests and the zero-infra default.
export function createMemoryPinIndex() {
  return createMemoryIndex();
}

// Synchronous file-index factory (local default when a durable-but-simple index
// is wanted without cloud infra).
export function createFilePinIndex(env = process.env) {
  return createFileIndex(env);
}
