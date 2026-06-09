# impo.ai Cloudflare Pages homepage

Static direct-upload site for the impo.ai homepage. The positioning is based on
the repo's real architecture: an impo.ai controller brokers browser actions to a
machine connector, and the connector drives real tmux sessions, windows, and
panes.

Deploy:

```sh
npx wrangler pages deploy cf-pages/impo-home --project-name=impo-ai --branch=main
```

Registration CTA:

```text
https://eng.impo.ai/auth/google/login?returnTo=%2Fcommand-center
```
