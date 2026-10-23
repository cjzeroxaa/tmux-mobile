// Drafts share the existing comment table, under their own key namespaces.
// Immutable versions and the latest pointer are committed together.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
export function memoryDraftStore({ persist = async () => {} } = {}) {
  const items = new Map();
  let pending = Promise.resolve();
  const key = (f, id) => JSON.stringify([f, id]);
  const mutate = (fn) => {
    const p = pending.then(fn);
    pending = p.catch(() => {});
    return p;
  };
  return {
    items,
    async get(f, id) {
      await pending;
      return structuredClone(items.get(key(f, id)) || null);
    },
    async list(f) {
      await pending;
      return structuredClone([...items.values()].filter((x) => x.family === f));
    },
    put(record, { expectedVersion } = {}) {
      return mutate(async () => {
        if (expectedVersion !== undefined &&
            (items.get(key(record.family, record.id))?.version || 0) !== expectedVersion)
          throw Object.assign(new Error("Sharing changed; refresh and try again"), { status: 409 });
        const next = new Map(items);
        next.set(key(record.family, record.id), structuredClone(record));
        await persist([...next.values()]);
        items.clear();
        for (const [k, v] of next) items.set(k, v);
      });
    },
    commit(head, version, expected) {
      return mutate(async () => {
        const old = items.get(key(head.family, head.id));
        if ((old?.version || 0) !== expected)
          throw Object.assign(new Error("Draft changed; retry publishing"), {
            status: 409,
          });
        const next = new Map(items);
        for (const r of [head, version])
          next.set(key(r.family, r.id), structuredClone(r));
        await persist([...next.values()]);
        items.clear();
        for (const [k, v] of next) items.set(k, v);
      });
    },
  };
}
export async function createDraftStore(env = process.env) {
  if (["dynamo", "dynamodb"].includes(env.TMUX_MOBILE_COMMENT_INDEX)) {
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const {
      DynamoDBDocumentClient,
      GetCommand,
      QueryCommand,
      PutCommand,
      TransactWriteCommand,
    } = await import("@aws-sdk/lib-dynamodb");
    const TableName = env.TMUX_MOBILE_COMMENTS_TABLE;
    if (!TableName)
      throw new Error("Draft storage requires the comments table");
    const client = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: env.TMUX_MOBILE_DYNAMO_REGION || env.AWS_REGION || "us-east-1",
      }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
    return {
      async get(family, id) {
        return (
          (
            await client.send(
              new GetCommand({
                TableName,
                Key: { family, id },
                ConsistentRead: true,
              }),
            )
          ).Item || null
        );
      },
      async list(family) {
        const items = [];
        let cursor;
        do {
          const r = await client.send(
            new QueryCommand({
              TableName,
              KeyConditionExpression: "#f = :f",
              ExpressionAttributeNames: { "#f": "family" },
              ExpressionAttributeValues: { ":f": family },
              ConsistentRead: true,
              ExclusiveStartKey: cursor,
            }),
          );
          items.push(...(r.Items || []));
          cursor = r.LastEvaluatedKey;
        } while (cursor);
        return items;
      },
      async put(Item, { expectedVersion } = {}) {
        try {
          await client.send(new PutCommand({ TableName, Item,
            ...(expectedVersion === undefined ? {} : expectedVersion === 0
              ? { ConditionExpression: "attribute_not_exists(id)" }
              : { ConditionExpression: "#v = :v", ExpressionAttributeNames: { "#v": "version" },
                  ExpressionAttributeValues: { ":v": expectedVersion } }),
          }));
        } catch (error) {
          if (error.name === "ConditionalCheckFailedException") {
            error.status = 409;
            error.message = "Sharing changed; refresh and try again";
          }
          throw error;
        }
      },
      async commit(head, version, expected) {
        try {
          await client.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Put: {
                    TableName,
                    Item: head,
                    ConditionExpression: expected
                      ? "#v = :v"
                      : "attribute_not_exists(id)",
                    ...(expected
                      ? {
                          ExpressionAttributeNames: { "#v": "version" },
                          ExpressionAttributeValues: { ":v": expected },
                        }
                      : {}),
                  },
                },
                {
                  Put: {
                    TableName,
                    Item: version,
                    ConditionExpression: "attribute_not_exists(id)",
                  },
                },
              ],
            }),
          );
        } catch (error) {
          if (
            error.name === "TransactionCanceledException" &&
            error.CancellationReasons?.some(
              (r) => r.Code === "ConditionalCheckFailed",
            )
          )
            error.status = 409;
          throw error;
        }
      },
    };
  }
  const file =
    env.TMUX_MOBILE_DRAFTS_CONFIG ||
    path.join(os.homedir(), ".config/tmux-mobile/drafts.json");
  const store = memoryDraftStore({
    persist: async (items) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(items), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    },
  });
  try {
    for (const r of JSON.parse(await readFile(file, "utf8")))
      store.items.set(JSON.stringify([r.family, r.id]), r);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return store;
}
