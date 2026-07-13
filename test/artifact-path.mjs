import assert from "node:assert/strict";

import { artifactPathCandidates, cleanArtifactPath } from "../lib/artifact-path.mjs";

assert.equal(cleanArtifactPath("./dist/index.html。"), "./dist/index.html");
assert.equal(cleanArtifactPath("`./dist/index.html`, "), "./dist/index.html");
assert.equal(cleanArtifactPath("(./dist/index.html)"), "./dist/index.html");
assert.equal(cleanArtifactPath("[open it](./dist/index.html)."), "./dist/index.html");
assert.equal(cleanArtifactPath("![preview](./out/shot.png)"), "./out/shot.png");
assert.equal(cleanArtifactPath("&quot;./report.html&quot;"), "./report.html");
assert.equal(cleanArtifactPath("docs/design/\n  report.html"), "docs/design/report.html");
assert.equal(cleanArtifactPath("file:///tmp/report.html"), "/tmp/report.html");

assert.deepEqual(artifactPathCandidates("./dist/index.html。"), [
  "./dist/index.html。",
  "./dist/index.html",
]);

assert.deepEqual(artifactPathCandidates("./My%20Report.html#preview"), [
  "./My%20Report.html#preview",
  "./My Report.html#preview",
  "./My%20Report.html",
  "./My Report.html",
]);

assert.deepEqual(artifactPathCandidates("[open](./out/app.html)."), [
  "[open](./out/app.html).",
  "./out/app.html",
]);

console.log("artifact path cleanup tests passed");
