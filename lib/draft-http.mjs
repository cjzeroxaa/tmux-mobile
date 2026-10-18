import { readFile } from "node:fs/promises";
import { locateDraftQuote } from "../public/draft-anchors.mjs";
import {
  draftTarget,
  draftFilename,
  draftGenerationPrompt,
  draftFeedbackPrompt,
  draftClientInstructions,
} from "./drafts.mjs";
let frameScript;
async function getFrameScript() {
  return (frameScript ||= await readFile(
    new URL("../public/draft-frame.js", import.meta.url),
    "utf8",
  ));
}
const csp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
export async function handleDraftHttp(
  req,
  res,
  url,
  { drafts, viewer, readJsonBody, sendJson, sendPrompt, origin },
) {
  if (!url.pathname.startsWith("/api/drafts")) return false;
  res.setHeader("Cache-Control", "private, no-store");
  try {
    if (!drafts)
      throw Object.assign(new Error("Draft storage is unavailable"), {
        status: 503,
      });
    const id = url.searchParams.get("id");
    if (req.method === "GET" && url.pathname === "/api/drafts") {
      sendJson(
        res,
        200,
        id
          ? await drafts.detail(viewer, id)
          : {
              drafts: await drafts.list(
                viewer,
                Object.fromEntries(url.searchParams),
              ),
            },
      );
    } else if (req.method === "GET" && url.pathname === "/api/drafts/content") {
      const version = Number(url.searchParams.get("version")) || undefined;
      const { html, record } = await drafts.read(viewer, id, version);
      if (url.searchParams.get("download") === "1") {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${record.filename}"`,
        });
        res.end(html);
      } else {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": csp,
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        });
        res.end(
          html.replace(
            /<\/body\s*>/i,
            `<script>${locateDraftQuote.toString()}\n${await getFrameScript()}</script></body>`,
          ),
        );
      }
    } else if (
      req.method === "POST" &&
      url.pathname === "/api/drafts/comments"
    ) {
      sendJson(res, 201, {
        comment: await drafts.comment(viewer, id, await readJsonBody(req)),
      });
    } else if (
      req.method === "PATCH" &&
      url.pathname === "/api/drafts/comments"
    ) {
      const body = await readJsonBody(req);
      await drafts.resolve(viewer, id, body.id, body.status);
      sendJson(res, 200, { ok: true });
    } else if (req.method === "POST" && url.pathname === "/api/drafts/prompt") {
      const body = await readJsonBody(req);
      let target, prompt;
      if (id) {
        const detail = await drafts.detail(viewer, id);
        target = detail.draft;
        const comments = detail.comments.filter((c) => c.status === "open");
        if (!comments.length)
          throw Object.assign(new Error("There are no open comments"), {
            status: 400,
          });
        prompt =
          draftFeedbackPrompt(target, comments) +
          draftClientInstructions(
            target,
            target.filename,
            origin,
            target.sourcePath,
          );
      } else {
        target = {
          ...draftTarget(body),
          machineId: String(body.machineId || ""),
        };
        const filename = draftFilename(body.filename),
          request = String(body.request || "").trim();
        if (!request || request.length > 4000)
          throw Object.assign(
            new Error("Describe what you want in the Draft"),
            { status: 400 },
          );
        prompt =
          draftGenerationPrompt(target, filename, request) +
          draftClientInstructions(target, filename, origin);
      }
      if (body.send === true) await sendPrompt(viewer, target, prompt);
      sendJson(res, 200, { prompt, sent: body.send === true });
    } else sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message });
  }
  return true;
}
