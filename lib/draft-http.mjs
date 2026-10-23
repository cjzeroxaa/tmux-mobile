import { readFile } from "node:fs/promises";
import { locateDraftQuote } from "../public/draft-anchors.mjs";
import { ASSET_ORIGIN, signDraftAssets } from './draft-assets.mjs';
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
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: ${ASSET_ORIGIN}; font-src data:; media-src data: blob: ${ASSET_ORIGIN}; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`;
// This is the only anonymous Draft route. It serves the latest document, never
// comments, machine/session metadata, history, or the private review controls.
export async function handlePublicDraftHttp(req, res, url, { drafts, assetSessionSecret }) {
  if (!url.pathname.startsWith("/d/")) return false;
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Content-Security-Policy", csp);
  let status = 200, html;
  try {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.setHeader("Allow", "GET, HEAD");
      throw Object.assign(new Error(), { status: 405 });
    }
    const match = url.pathname.match(/^\/d\/([a-f0-9]{32})\/([A-Za-z0-9_-]{43})$/);
    if (!match) throw Object.assign(new Error(), { status: 404 });
    if (!drafts) throw Object.assign(new Error(), { status: 503 });
    const content = await drafts.readPublic(match[1], match[2]);
    html = signDraftAssets(content.html, content.record.machineId, assetSessionSecret);
  } catch (error) {
    status = error.status || 500;
    const message = status === 404 ? "This public Draft link is unavailable."
      : status === 405 ? "This link is read-only." : "Could not load this Draft. Please try again.";
    html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Draft unavailable</title><body><h1>${message}</h1></body></html>`;
  }
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
  res.end(req.method === "HEAD" ? undefined : html);
  return true;
}
export async function handleDraftHttp(
  req,
  res,
  url,
  { drafts, viewer, readJsonBody, sendJson, sendPrompt, origin, assetSessionSecret },
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
        const rendered = signDraftAssets(html, record.machineId, assetSessionSecret);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": csp,
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        });
        res.end(
          rendered.replace(
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
    } else if (req.method === "PUT" && url.pathname === "/api/drafts/sharing") {
      if (!/^application\/json(?:;|$)/i.test(req.headers?.["content-type"] || "") ||
          req.headers?.["sec-fetch-site"] === "cross-site" ||
          (req.headers?.origin && req.headers.origin !== origin))
        throw Object.assign(new Error("Sharing must be changed from this Draft page"), { status: 403 });
      const body = await readJsonBody(req);
      sendJson(res, 200, { sharing: await drafts.setSharing(viewer, id, body.enabled) });
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
