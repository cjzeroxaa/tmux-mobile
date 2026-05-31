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
  `127.0.0.1:3737`. Started from `/Users/homo/src/tmux-mobile` with `npm start`
  (or `node server.mjs` directly).
- Tailscale Serve fronts it on the tailnet:
  `https://homos-mac-mini.tigris-bigeye.ts.net:8447`  →  `http://127.0.0.1:3737`
  (Check live mapping with `tailscale serve status`.)

That's it. Don't "improve" this by installing a LaunchAgent, writing a wrapper
script, or anything similar unless the human explicitly asks. Keep it boring.

## 3. After ANY restart or change, verify the external Tailscale URL works

You (Claude) are on the same tailnet as the server, so you can — and **must** —
hit the external URL yourself after touching anything that could affect it.
"Verified locally on 127.0.0.1:3737" is **not enough**. Loopback works even
when Tailscale Serve is broken or pointing at a stale port.

The check, every time:

```bash
curl -sS -o /dev/null -w "HTTP %{http_code}\n" \
  https://homos-mac-mini.tigris-bigeye.ts.net:8447/
```

Expect `HTTP 200`. Anything else = not done. Do this after:

- restarting `node server.mjs`
- pulling/changing code that the server runs
- editing `public/` assets (the user will reload over Tailscale, so verify the
  Tailscale URL serves the new bytes)
- touching `tailscale serve` config
- any operation where you think "this should be fine"

If the external URL doesn't return 200, you are not done — fix it before
handing back. If this server is healthy externally, the job is done.
