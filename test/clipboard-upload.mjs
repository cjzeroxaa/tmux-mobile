import assert from "node:assert/strict";
import { clipboardImageFiles, uploadFilename } from "../public/clipboard-upload.js";

const png = { name: "screenshot.png", type: "image/png" };
const text = { name: "notes.txt", type: "text/plain" };

assert.deepEqual(
  clipboardImageFiles({
    clipboardData: {
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => png },
        { kind: "file", type: "text/plain", getAsFile: () => text },
      ],
      files: [png],
    },
  }),
  [png],
  "extracts only clipboard images without duplicating the files fallback",
);

assert.deepEqual(
  clipboardImageFiles({ clipboardData: { items: [], files: [text, png] } }),
  [png],
  "uses clipboardData.files when items contains no images",
);
assert.deepEqual(clipboardImageFiles({}), []);

assert.equal(uploadFilename(png), "screenshot.png");
assert.equal(uploadFilename({ name: "", type: "image/jpeg" }), "pasted-image.jpg");
assert.equal(uploadFilename({ name: "", type: "image/svg+xml" }), "pasted-image.svg");
assert.equal(uploadFilename({ name: "", type: "image/x-custom" }), "pasted-image");

console.log("clipboard upload unit tests passed");
