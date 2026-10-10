import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  enabled: false, start: "21:00", end: "08:00", timeZone: "UTC",
});
const RECORD_ID = "notification-settings#global";
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function validateNotificationSettings(value) {
  const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!value || typeof value.enabled !== "boolean") fail("Quiet hours must be on or off.");
  if (!timePattern.test(value.start) || !timePattern.test(value.end)) fail("Use 24-hour times in HH:mm format.");
  if (value.start === value.end) fail("Start and end times must be different.");
  if (typeof value.timeZone !== "string" || value.timeZone.length > 100) fail("Choose a valid timezone.");
  let timeZone;
  try { timeZone = new Intl.DateTimeFormat("en", { timeZone: value.timeZone }).resolvedOptions().timeZone; }
  catch { fail("Choose a valid timezone, such as America/Los_Angeles."); }
  return { enabled: value.enabled, start: value.start, end: value.end, timeZone };
}

export function isNotificationQuietTime(settings, value = Date.now()) {
  if (!settings?.enabled) return false;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const minute = Number(parts.find(p => p.type === "hour").value) * 60 + Number(parts.find(p => p.type === "minute").value);
  const toMinutes = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const start = toMinutes(settings.start), end = toMinutes(settings.end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function canEditNotificationSettings(viewer, superAdmins, requireAuth = true) {
  if (!requireAuth) return true;
  return superAdmins.includes(String(viewer?.email || viewer?.userId || "").trim().toLowerCase());
}

// One controller-wide preference, stored beside existing user preferences under
// its own record key. Cached reads avoid adding database work to inventory ticks.
export async function createNotificationSettingsStore(env = process.env) {
  const kind = String(env.TMUX_MOBILE_NOTIFICATION_SETTINGS_STORE || env.TMUX_MOBILE_SNIPPETS_STORE || "file").toLowerCase();
  let current = { ...DEFAULT_NOTIFICATION_SETTINGS, updatedAt: 0 };
  let read, write;
  if (kind === "dynamo" || kind === "dynamodb") {
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const { DynamoDBDocumentClient, GetCommand, PutCommand } = await import("@aws-sdk/lib-dynamodb");
    const table = env.TMUX_MOBILE_SNIPPETS_DYNAMO_TABLE || env.TMUX_MOBILE_USER_PREFS_DYNAMO_TABLE;
    if (!table) throw new Error("Notification settings require the user preferences DynamoDB table.");
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.TMUX_MOBILE_USER_PREFS_DYNAMO_REGION || env.TMUX_MOBILE_SNIPPETS_DYNAMO_REGION || env.AWS_REGION || "us-east-1" }));
    read = async () => (await client.send(new GetCommand({ TableName: table, Key: { id: RECORD_ID }, ConsistentRead: true }))).Item;
    write = async record => { await client.send(new PutCommand({ TableName: table, Item: { id: RECORD_ID, ...record } })); };
  } else if (kind === "file") {
    const target = env.TMUX_MOBILE_NOTIFICATION_SETTINGS_CONFIG || path.join(os.homedir(), ".config", "tmux-mobile", "notification-settings.json");
    read = async () => { try { return JSON.parse(await readFile(target, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
    write = async record => {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(record) + "\n", { mode: 0o600 });
      await rename(temp, target);
    };
  } else if (kind === "memory") {
    let record;
    read = async () => record;
    write = async value => { record = value; };
  } else throw new Error(`Unknown notification settings store: ${kind}`);

  let writes = Promise.resolve();
  async function refresh() {
    const task = writes.then(async () => {
      const record = await read();
      current = record ? { ...validateNotificationSettings(record), updatedAt: record.updatedAt || 0 } : { ...DEFAULT_NOTIFICATION_SETTINGS, updatedAt: 0 };
      return { ...current };
    });
    writes = task.catch(() => {});
    return task;
  }
  await refresh();
  return {
    kind,
    current: () => ({ ...current }),
    refresh,
    async save(value) {
      const record = { ...validateNotificationSettings(value), updatedAt: Date.now() };
      const task = writes.then(async () => { await write(record); current = record; return { ...record }; });
      writes = task.catch(() => {});
      return task;
    },
  };
}
