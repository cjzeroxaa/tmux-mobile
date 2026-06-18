#!/usr/bin/env node
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { appRevision } from "../lib/revision.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outdir = path.join(rootDir, "dist");
const outfile = path.join(outdir, "tmux-mobile-connector.mjs");
const revision = appRevision(rootDir);

await mkdir(outdir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(rootDir, "server.mjs")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  mainFields: ["module", "main"],
  banner: {
    js: [
      "#!/usr/bin/env node",
      `// tmux-mobile connector bundle, revision ${revision}`,
      "process.env.TMUX_MOBILE_REVISION ||= " + JSON.stringify(revision) + ";",
    ].join("\n"),
  },
  define: {
    "process.env.TMUX_MOBILE_CONNECTOR_BUNDLE": JSON.stringify("1"),
  },
  logLevel: "silent",
});

const info = await stat(outfile);
await writeFile(
  path.join(outdir, "tmux-mobile-connector.json"),
  `${JSON.stringify(
    {
      revision,
      file: path.basename(outfile),
      bytes: info.size,
      run: "node dist/tmux-mobile-connector.mjs --register https://eng.impo.ai",
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(`built ${path.relative(rootDir, outfile)} (${info.size} bytes, revision ${revision})`);

