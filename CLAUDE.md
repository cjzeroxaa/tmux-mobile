# Claude operating notes for this repo

## 1. The 127.0.0.1:3737 server is the gateway for this whole machine

`node server.mjs` listening on `127.0.0.1:3737` is **SUPER important**. It is
the single way the human reaches this Mac from their phone (and from anywhere
else). If this server is down, the machine is effectively unreachable. Treat
every operation that touches it as production.

## 2. The setup is intentionally simple: one Node process + Tailscale Serve

There is no launchd, no systemd, no Docker, no process manager. Don't add one.
The whole thing is:

- `node server.mjs` running in the foreground / a background shell, bound to
  `127.0.0.1:3737`. Started from the repo checkout with `npm start`
  (or `node server.mjs` directly).
- Tailscale Serve fronts it on the tailnet:
  `https://<your-machine>.<your-tailnet>.ts.net:<port>`  →  `http://127.0.0.1:3737`
  (Check live mapping with `tailscale serve status`.)

That's it. Don't "improve" this by installing a LaunchAgent, writing a wrapper
script, or anything similar unless the human explicitly asks. Keep it boring.
