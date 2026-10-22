import { createHash, randomUUID } from "node:crypto";
import { contentKey } from "./artifact-storage.mjs";
import { isDraftAssetUrl, validateAssetReferences } from './draft-assets.mjs';
export const DRAFT_UPLOAD_PATH = "/agent/drafts";
export const MAX_DRAFT_BYTES = 5 * 1024 * 1024;
const INDEX = "tmax-drafts";
const family = (id) => `tmax-draft#${id}`;
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
export function draftTarget(input) {
  const kind = String(input?.kind || "");
  const sessionId = String(input?.sessionId || "");
  if (
    !["claude", "codex", "pi"].includes(kind) ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)
  )
    fail("Invalid draft session");
  return { kind, sessionId };
}
export function draftFilename(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.html$/.test(String(name || "")))
    fail("Use a simple .html filename");
  return name;
}
export function draftRelativePath(target, filename) {
  const { kind, sessionId } = draftTarget(target);
  return `.local/share/tmux-mobile/drafts/${kind}/${sessionId}/${draftFilename(filename)}`;
}
export function validateDraftHtml(bytes, { machineId } = {}) {
  if (!bytes.length || bytes.length > MAX_DRAFT_BYTES)
    fail("HTML must be between 1 byte and 5 MB", 413);
  const html = bytes.toString("utf8");
  if (/<(?:video|audio|source)\b[^>]*\bsrc\s*=\s*["']?\s*data:(?:video|audio)\//i.test(html))
    fail('Upload audio/video with the Draft asset helper; do not base64-embed media');
  if (
    !/<body[\s>]/i.test(html) ||
    !/<\/body\s*>/i.test(html) ||
    !/<html[\s>]/i.test(html) ||
    !/<\/html\s*>\s*$/i.test(html)
  )
    fail("Write a complete HTML document, ending with </html>");
  // Only this machine's managed media may leave the HTML. Scripts remain inline.
  validateAssetReferences(html, machineId);
  const checkedHtml = html.replace(/<(img|video|audio|source|track)\b[^>]*>/gi, tag =>
    tag.replace(/\b(src|poster)\s*=\s*(["'])(.*?)\2/gi, (attribute, name, quote, value) =>
      isDraftAssetUrl(value, machineId) ? `${name}=${quote}data:,managed-asset${quote}` : attribute));
  if (
    /<(?:script|img|iframe|video|audio|source|embed)\b[^>]*\bsrc\s*=\s*["']?\s*(?!data:|blob:)[^\s"'>]+/i.test(
      checkedHtml,
    ) ||
    /<link\b[^>]*\bhref\s*=/i.test(checkedHtml) ||
    /@import\b|url\(\s*["']?\s*(?:https?:|\/\/)/i.test(checkedHtml)
  )
    fail("Embed scripts/styles; upload external images and media with the T-Max Draft asset helper");
  return html;
}
export function createDrafts({ store, storage, canAccess, listMachines = () => [] }) {
  const get = async (viewer, id) => {
    const head = await store.get(INDEX, String(id || ""));
    if (!head || !canAccess(viewer, head.machineId))
      fail("Draft not found", 404);
    return head;
  };
  return {
    get,
    async list(viewer, filter = {}) {
      const visible = (await store.list(INDEX)).filter(d => canAccess(viewer, d.machineId));
      const names = new Map((await store.list("tmax-draft-machines")).map(m => [m.id, m.name]));
      const ids = new Set(visible.map(d => d.machineId));
      // Keep labels separately from immutable draft versions. This also fills
      // in names for older drafts and preserves them after a machine goes offline.
      for (const machine of await listMachines(viewer)) {
        if (!ids.has(machine.id) || !machine.hostname || names.get(machine.id) === machine.hostname) continue;
        await store.put({ family: "tmax-draft-machines", id: machine.id, name: machine.hostname });
        names.set(machine.id, machine.hostname);
      }
      return visible
        .filter(
          (d) =>
            (!filter.machineId || d.machineId === filter.machineId) &&
            (!filter.sessionId ||
              (d.sessionId === filter.sessionId && d.kind === filter.kind)),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(d => ({ ...d, machineName: names.get(d.machineId) || d.machineId }));
    },
    async publish({ machineId, ownerId, metadata, bytes }) {
      const target = draftTarget(metadata),
        filename = draftFilename(metadata.filename);
      const html = validateDraftHtml(bytes, { machineId });
      const id = createHash("sha256")
        .update(
          JSON.stringify([machineId, target.kind, target.sessionId, filename]),
        )
        .digest("hex")
        .slice(0, 32);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const sourcePath = String(metadata.sourcePath || "");
      if (
        sourcePath &&
        (!sourcePath.startsWith("/") ||
          sourcePath.length > 4096 ||
          /[\x00-\x1f]/.test(sourcePath))
      )
        fail("Invalid source path");
      const old = await store.get(INDEX, id);
      if (
        old?.sha256 === sha256 &&
        (!sourcePath || old.sourcePath === sourcePath)
      )
        return { id, version: old.version, sha256, deduped: true };
      if (
        !Number.isSafeInteger(metadata.expectedVersion) ||
        metadata.expectedVersion !== (old?.version || 0)
      )
        fail(
          "Draft changed; read the current version and comments before publishing again",
          409,
        );
      const key = contentKey(sha256, ".html");
      await storage.put(key, bytes, {
        contentType: "text/html; charset=utf-8",
      });
      const now = Date.now(),
        version = (old?.version || 0) + 1;
      const title = (
        html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || filename
      )
        .replace(/<[^>]*>/g, "")
        .trim()
        .slice(0, 160);
      const head = {
        family: INDEX,
        id,
        machineId,
        ownerId,
        ...target,
        filename,
        sourcePath: sourcePath || old?.sourcePath || "",
        title,
        sha256,
        storageKey: key,
        version,
        size: bytes.length,
        createdAt: old?.createdAt || now,
        updatedAt: now,
      };
      await store.commit(
        head,
        {
          ...head,
          family: family(id),
          id: `v#${String(version).padStart(8, "0")}`,
          draftId: id,
          createdAt: now,
        },
        old?.version || 0,
      );
      return { id, version, sha256 };
    },
    async read(viewer, id, version) {
      const head = await get(viewer, id);
      const record = version
        ? await store.get(family(id), `v#${String(version).padStart(8, "0")}`)
        : head;
      if (!record) fail("Version not found", 404);
      const blob = await storage.get(record.storageKey);
      if (!blob) fail("HTML not found", 404);
      return { head, record, html: blob.bytes.toString("utf8") };
    },
    async detail(viewer, id) {
      const head = await get(viewer, id),
        records = await store.list(family(id));
      return {
        draft: head,
        versions: records
          .filter((r) => r.id.startsWith("v#"))
          .sort((a, b) => b.version - a.version),
        comments: records
          .filter((r) => r.id.startsWith("c#"))
          .sort((a, b) => a.createdAt - b.createdAt),
      };
    },
    async comment(viewer, id, body) {
      const head = await get(viewer, id);
      const version = Number(body.version);
      if (
        !Number.isSafeInteger(version) ||
        version < 1 ||
        version > head.version
      )
        fail("Invalid comment version");
      const text = String(body.text || "").trim();
      if (!text || text.length > 4000)
        fail("Enter a comment (up to 4,000 characters)");
      let anchor = null;
      if (body.anchor != null) {
        const quote = body.anchor.quote;
        if (typeof quote !== "string" || !quote.trim() || quote.length > 12000)
          fail("Invalid selected text");
        anchor = {
          quote,
          prefix: String(body.anchor.prefix || "").slice(-80),
          suffix: String(body.anchor.suffix || "").slice(0, 80),
        };
      }
      const comment = {
        family: family(id),
        id: `c#${randomUUID()}`,
        version,
        scope: anchor ? "selection" : "document",
        anchor,
        text,
        authorId: viewer.userId,
        authorEmail: viewer.email || viewer.userId,
        status: "open",
        createdAt: Date.now(),
      };
      await store.put(comment);
      return comment;
    },
    async resolve(viewer, id, commentId, status) {
      await get(viewer, id);
      if (!["open", "resolved"].includes(status)) fail("Invalid status");
      const comment = await store.get(family(id), commentId);
      if (!comment?.id.startsWith("c#")) fail("Comment not found", 404);
      await store.put({ ...comment, status });
    },
  };
}
export function draftGenerationPrompt(target, filename, request = "") {
  return `Read the T-Max Drafts skill at https://eng.xyznot.com/skills/tmax-drafts/SKILL.md. For PR/code explanations use its bundled PR Lens generation guide; publish only to this T-Max Host, never to public PR Lens or GitHub.\nCreate a reviewable Draft for this session. ${request}\nWrite one complete HTML entry file at ~/${draftRelativePath(target, filename)}. Create its parent directory first. Embed CSS, JavaScript and small diagrams. Upload MP4, audio, large images and downloads with the installed tmax-drafts scripts/upload-asset.mjs helper, then use its returned asset URL. Never base64-embed audio/video. Only the managed Draft asset origin is allowed; no CDN scripts, remote fonts or fetch calls. Credentials stay in ~/.config/tmux-mobile/draft-assets.json and never enter the HTML. End with </html>. Write to a temporary file then rename atomically to this path. Publish it using the Draft client described below; no Pin action is needed. The page provides text-selection comments, so do not implement a separate comment system. Keep this filename for later revisions. Include the full deliverable, not just a summary.`;
}
export function draftFeedbackPrompt(draft, comments) {
  return `Revise the existing Draft at ${JSON.stringify(draft.sourcePath || `~/${draftRelativePath(draft, draft.filename)}`)} using the feedback below. Keep the same filename and all unaffected content. Read the complete file before editing. Publish a full HTML document, preserving managed asset URLs and using the Draft asset helper for new media, by writing a temporary file and renaming it atomically. Comments identify the version they refer to. Overall comments apply to the whole draft; if a selected quote no longer exists, interpret it in context rather than replacing unrelated text.\n\n${comments.map((c, i) => `${i + 1}. Version ${c.version}\n${c.anchor?.quote ? `Selected text: ${JSON.stringify(c.anchor.quote)}` : "Overall comment (whole draft)"}\nComment: ${c.text}`).join("\n\n")}`;
}

export function draftClientInstructions(
  target,
  filename,
  origin = "https://eng.xyznot.com",
  sourcePath = "",
) {
  draftTarget(target);
  draftFilename(filename);
  const api = new URL(origin).origin;
  const fileArgument = sourcePath
    ? "'" + sourcePath.replaceAll("'", "'\"'\"'") + "'"
    : `~/${draftRelativePath(target, filename)}`;
  return `\nGeneration and feedback tool (uses this machine's existing Connector login):\ncurl -fsSL ${api}/draft-client.mjs -o /tmp/tmax-draft-client.mjs\nnode /tmp/tmax-draft-client.mjs publish --api ${api} --kind ${target.kind} --session ${target.sessionId} --file ${fileArgument}\nThe result contains a stable Draft URL and id. Read feedback with: node /tmp/tmax-draft-client.mjs comments --api ${api} --id <draft-id>\nKeep the file's .draft.json receipt, which records the version for safe updates. Never upload credentials or include them in the HTML.`;
}
