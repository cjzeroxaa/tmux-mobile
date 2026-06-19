// Unit tests for appRevision() precedence (lib/revision.mjs). The controller's
// reported revision is the deploy-change signal connected agents watch, so it
// MUST be unique per deploy. The critical case: the Dockerfile bakes
// TMUX_MOBILE_REVISION="dev", so on Cloud Run that constant must NOT shadow
// K_REVISION (which is unique per deploy) — otherwise agents never migrate off a
// terminated instance and the UI hangs on "Waiting for <machine>".

import assert from "node:assert/strict";
import { appRevision } from "../lib/revision.mjs";

const saved = { rev: process.env.TMUX_MOBILE_REVISION, k: process.env.K_REVISION };
function setEnv(rev, k) {
  if (rev === undefined) delete process.env.TMUX_MOBILE_REVISION;
  else process.env.TMUX_MOBILE_REVISION = rev;
  if (k === undefined) delete process.env.K_REVISION;
  else process.env.K_REVISION = k;
}

try {
  // An explicit, meaningful TMUX_MOBILE_REVISION wins (e.g. push-image.sh SHA).
  setEnv("abc123-manual", "svc-00009-xyz");
  assert.equal(appRevision(), "abc123-manual", "explicit revision wins");

  // The baked "dev" default must NOT shadow K_REVISION on Cloud Run.
  setEnv("dev", "tmux-mobile-controller-dev-00027-zwm");
  assert.equal(
    appRevision(),
    "tmux-mobile-controller-dev-00027-zwm",
    "K_REVISION beats the baked 'dev' (the deploy-hang bug)",
  );

  // K_REVISION used when TMUX_MOBILE_REVISION is unset.
  setEnv(undefined, "tmux-mobile-controller-dev-00028-aaa");
  assert.equal(appRevision(), "tmux-mobile-controller-dev-00028-aaa", "K_REVISION used when unset");

  // With neither cloud signal, baked "dev" is kept (rather than nothing) — but
  // only after K_REVISION is absent.
  setEnv("dev", undefined);
  assert.equal(appRevision("/nonexistent-dir-xyz"), "dev", "baked dev as last resort");

  // Two consecutive Cloud Run deploys report DIFFERENT revisions (the property
  // agent migration depends on).
  setEnv("dev", "svc-00027-zwm");
  const a = appRevision();
  setEnv("dev", "svc-00028-qrs");
  const b = appRevision();
  assert.notEqual(a, b, "consecutive deploys report distinct revisions");

  console.log("revision unit tests passed");
} finally {
  setEnv(saved.rev, saved.k);
}
